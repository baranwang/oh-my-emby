import { Schema } from "effect";

const decodeUrl = Schema.decodeUnknownSync(Schema.URLFromString);

const isHttpUrl = (value: string): value is string => {
  try {
    const url = decodeUrl(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      !value.includes("?") &&
      !value.includes("#")
    );
  } catch {
    return false;
  }
};

export const ServerId = Schema.NonEmptyString.pipe(Schema.brand("ServerId"));
export const SourceLibraryId = Schema.NonEmptyString.pipe(Schema.brand("SourceLibraryId"));
export const VirtualLibraryId = Schema.NonEmptyString.pipe(Schema.brand("VirtualLibraryId"));
export const RequestId = Schema.NonEmptyString.pipe(Schema.brand("RequestId"));
export const HttpUrl = Schema.NonEmptyString.pipe(
  Schema.refine(isHttpUrl, { expected: "an HTTP(S) URL" }),
  Schema.brand("HttpUrl"),
);

export const SecretPatch = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Preserve") }),
  Schema.Struct({ _tag: Schema.Literal("Set"), value: Schema.NonEmptyString }),
  Schema.Struct({ _tag: Schema.Literal("Clear") }),
]);

export const BootstrapView = Schema.Struct({ initialized: Schema.Boolean });
export const SessionView = Schema.Struct({
  authenticated: Schema.Boolean,
  username: Schema.NullOr(Schema.NonEmptyString),
});
export const CredentialsInput = Schema.Struct({
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
});
export const PasswordChangeInput = Schema.Struct({
  currentPassword: Schema.NonEmptyString,
  newPassword: Schema.NonEmptyString,
});

export const UserAgentPolicy = Schema.Literals(["fixed", "client-preferred", "passthrough"]);
export const MetadataProviderId = Schema.Literals(["tmdb", "trakt"]);
export const MetadataProviderStatus = Schema.Literals(["unconfigured", "ready", "degraded"]);

const EndpointPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const isEndpointHost = (host: string) => {
  try {
    const url = new URL(`http://${host}`);
    return (
      host === host.trim() &&
      (host.startsWith("[") ? /^\[[^\]]+\]$/.test(host) : !host.includes(":")) &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};
const EndpointHost = Schema.NonEmptyString.check(
  Schema.makeFilter(isEndpointHost, {
    expected: "a hostname without credentials, port, path, query, or fragment",
  }),
);
const EndpointPath = Schema.String.check(
  Schema.makeFilter(
    (path) => path === "" || (path.startsWith("/") && !path.includes("?") && !path.includes("#")),
    { expected: "an empty path or a leading-slash path without query or fragment" },
  ),
);
const ServerEndpointFields = {
  protocol: Schema.Literals(["http", "https"]),
  host: EndpointHost,
  port: Schema.NullOr(EndpointPort),
  path: EndpointPath,
};

export const ServerEndpointInput = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyString),
  ...ServerEndpointFields,
});

const endpointKey = (endpoint: typeof ServerEndpointInput.Type) => {
  const port = endpoint.port === null ? "" : `:${endpoint.port}`;
  return new URL(`${endpoint.protocol}://${endpoint.host}${port}${endpoint.path}`).href;
};

const ServerEndpointsInput = Schema.Array(ServerEndpointInput).check(
  Schema.isMinLength(1),
  Schema.makeFilter((endpoints) =>
    new Set(endpoints.map(endpointKey)).size === endpoints.length
      ? undefined
      : "unique normalized endpoint URLs",
  ),
);

export const ServerInput = Schema.Struct({
  name: Schema.NonEmptyString,
  endpoints: ServerEndpointsInput,
  username: Schema.NonEmptyString,
  password: SecretPatch,
  userAgentPolicy: UserAgentPolicy,
  userAgent: Schema.NullOr(Schema.NonEmptyString),
  enabled: Schema.Boolean,
}).check(
  Schema.makeFilter((server) =>
    (server.userAgentPolicy === "fixed" && server.userAgent === null) ||
    (server.userAgentPolicy === "passthrough" && server.userAgent !== null)
      ? "fixed requires a User-Agent and passthrough stores none"
      : undefined,
  ),
);

export const ServerEndpointView = Schema.Struct({
  id: Schema.NonEmptyString,
  ...ServerEndpointFields,
  displayUrl: HttpUrl,
  verifiedCatalogId: Schema.NullOr(Schema.NonEmptyString),
  health: Schema.Literals(["unknown", "healthy", "degraded"]),
  lastSuccessAtMs: Schema.NullOr(Schema.Int),
});
export const ServerView = Schema.Struct({
  id: ServerId,
  name: Schema.NonEmptyString,
  endpoints: Schema.Array(ServerEndpointView).check(Schema.isMinLength(1)),
  username: Schema.NonEmptyString,
  hasPassword: Schema.Boolean,
  userAgentPolicy: UserAgentPolicy,
  userAgent: Schema.NullOr(Schema.NonEmptyString),
  enabled: Schema.Boolean,
  verifiedCatalogId: Schema.NullOr(Schema.NonEmptyString),
  generation: Schema.Int,
  health: Schema.Literals(["unknown", "healthy", "degraded"]),
});
export const SourceLibraryView = Schema.Struct({
  id: SourceLibraryId,
  serverId: ServerId,
  name: Schema.NonEmptyString,
  mediaType: Schema.Literals(["movies", "series"]),
});
export const SourceBindingInput = Schema.Struct({
  serverId: ServerId,
  sourceLibraryId: SourceLibraryId,
  enabled: Schema.Boolean,
});
export const SourceBindingView = Schema.Struct({
  ...SourceBindingInput.fields,
  sourceLibraryName: Schema.NonEmptyString,
});
export const VirtualLibraryInput = Schema.Struct({
  name: Schema.NonEmptyString,
  mediaType: Schema.Literals(["movies", "series"]),
  sources: Schema.Array(SourceBindingInput),
  enabled: Schema.Boolean,
});
export const VirtualLibraryView = Schema.Struct({
  id: VirtualLibraryId,
  name: Schema.NonEmptyString,
  mediaType: Schema.Literals(["movies", "series"]),
  sources: Schema.Array(SourceBindingView),
  enabled: Schema.Boolean,
});
export const ConnectionTestView = Schema.Struct({
  reachable: Schema.Boolean,
  catalogId: Schema.NullOr(Schema.NonEmptyString),
  endpoints: Schema.Array(
    Schema.Struct({
      endpointId: Schema.NonEmptyString,
      reachable: Schema.Boolean,
      catalogId: Schema.NullOr(Schema.NonEmptyString),
      health: Schema.Literals(["unknown", "healthy", "degraded"]),
    }),
  ),
});
const MetadataProviderInput = Schema.Struct({
  id: MetadataProviderId,
  enabled: Schema.Boolean,
  order: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  language: Schema.NullOr(Schema.NonEmptyString),
  credential: SecretPatch,
});
const MetadataProviderView = Schema.Struct({
  id: MetadataProviderId,
  enabled: Schema.Boolean,
  order: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  language: Schema.NullOr(Schema.NonEmptyString),
  hasCredential: Schema.Boolean,
  status: MetadataProviderStatus,
});
const orderedProviders = <A extends { readonly id: "tmdb" | "trakt"; readonly order: number }>(
  providers: readonly [A, A],
) =>
  providers[0].order === 0 && providers[1].order === 1 && providers[0].id !== providers[1].id
    ? undefined
    : "exactly one TMDB and one Trakt provider ordered by order";

export const MetadataProviderSettingsInput = Schema.Struct({
  providers: Schema.Tuple([MetadataProviderInput, MetadataProviderInput]).check(
    Schema.makeFilter(orderedProviders),
  ),
});
export const MetadataProviderSettingsView = Schema.Struct({
  providers: Schema.Tuple([MetadataProviderView, MetadataProviderView]).check(
    Schema.makeFilter(orderedProviders),
  ),
});
export const ServerHealthView = Schema.Struct({
  serverId: ServerId,
  health: Schema.Literals(["unknown", "healthy", "degraded"]),
  lastSuccessAtMs: Schema.NullOr(Schema.Int),
});
export const SystemStatusView = Schema.Struct({
  database: Schema.Literals(["healthy", "degraded"]),
  cacheEntries: Schema.Int,
  maintenanceLastRunAtMs: Schema.NullOr(Schema.Int),
  outboxPending: Schema.Int,
  outboxFailed: Schema.Int,
  outboxUncertain: Schema.Int,
  upstreamHealthy: Schema.Int,
  upstreamDegraded: Schema.Int,
  upstreamUnknown: Schema.Int,
});
export const OutboxFailureView = Schema.Struct({
  serverId: ServerId,
  code: Schema.NonEmptyString,
  failedAtMs: Schema.Int,
  attemptCount: Schema.Int,
  nextAttemptAtMs: Schema.NullOr(Schema.Int),
  uncertainSinceMs: Schema.NullOr(Schema.Int),
});

export type BootstrapView = typeof BootstrapView.Type;
export type SessionView = typeof SessionView.Type;
export type PasswordChangeInput = typeof PasswordChangeInput.Type;
export type SecretPatch = typeof SecretPatch.Type;
export type UserAgentPolicy = typeof UserAgentPolicy.Type;
export type ServerEndpointInput = typeof ServerEndpointInput.Type;
export type ServerEndpointView = typeof ServerEndpointView.Type;
export type ServerInput = typeof ServerInput.Type;
export type ServerView = typeof ServerView.Type;
export type ConnectionTestView = typeof ConnectionTestView.Type;
export type MetadataProviderSettingsInput = typeof MetadataProviderSettingsInput.Type;
export type MetadataProviderSettingsView = typeof MetadataProviderSettingsView.Type;
export type ServerHealthView = typeof ServerHealthView.Type;
export type SourceLibraryView = typeof SourceLibraryView.Type;
export type SourceBindingInput = typeof SourceBindingInput.Type;
export type VirtualLibraryInput = typeof VirtualLibraryInput.Type;
export type VirtualLibraryView = typeof VirtualLibraryView.Type;
export type SystemStatusView = typeof SystemStatusView.Type;
export type OutboxFailureView = typeof OutboxFailureView.Type;
