import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  Conflict,
  ForbiddenOrigin,
  Internal,
  NotFound,
  Timeout,
  Unauthorized,
  UpstreamRejected,
  UpstreamUnavailable,
  ValidationFailed,
} from "./errors.js";
import {
  BootstrapView,
  ConnectionTestView,
  CredentialsInput,
  MetadataProviderSettingsInput,
  MetadataProviderSettingsView,
  OutboxFailureView,
  PasswordChangeInput,
  ServerHealthView,
  ServerId,
  ServerInput,
  ServerView,
  SessionView,
  SourceLibraryView,
  SystemStatusView,
  VirtualLibraryId,
  VirtualLibraryInput,
  VirtualLibraryView,
} from "./schemas.js";

const readErrors = [Unauthorized, NotFound, Internal] as const;
const writeErrors = [
  Unauthorized,
  ForbiddenOrigin,
  ValidationFailed,
  NotFound,
  Conflict,
  Internal,
] as const;
const upstreamErrors = [
  Unauthorized,
  ForbiddenOrigin,
  ValidationFailed,
  NotFound,
  Conflict,
  UpstreamUnavailable,
  UpstreamRejected,
  Timeout,
  Internal,
] as const;

const bootstrap = HttpApiGroup.make("bootstrap").add(
  HttpApiEndpoint.get("getBootstrap", "/bootstrap", { success: BootstrapView, error: Internal }),
);

const auth = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.get("getSession", "/session", { success: SessionView, error: Internal }),
  HttpApiEndpoint.post("claim", "/claim", {
    payload: CredentialsInput,
    success: SessionView,
    error: [ForbiddenOrigin, ValidationFailed, Conflict, Internal],
  }),
  HttpApiEndpoint.post("login", "/login", {
    payload: CredentialsInput,
    success: SessionView,
    error: [Unauthorized, ForbiddenOrigin, ValidationFailed, Internal],
  }),
  HttpApiEndpoint.post("logout", "/logout", {
    success: HttpApiSchema.NoContent,
    error: [Unauthorized, ForbiddenOrigin, Internal],
  }),
  HttpApiEndpoint.put("changePassword", "/password", {
    payload: PasswordChangeInput,
    success: HttpApiSchema.NoContent,
    error: [Unauthorized, ForbiddenOrigin, ValidationFailed, Internal],
  }),
);

const servers = HttpApiGroup.make("servers").add(
  HttpApiEndpoint.get("listServers", "/servers", {
    success: Schema.Array(ServerView),
    error: [Unauthorized, Internal],
  }),
  HttpApiEndpoint.post("createServer", "/servers", {
    payload: ServerInput,
    success: ServerView,
    error: writeErrors,
  }),
  HttpApiEndpoint.get("getServer", "/servers/:id", {
    params: { id: ServerId },
    success: ServerView,
    error: readErrors,
  }),
  HttpApiEndpoint.put("updateServer", "/servers/:id", {
    params: { id: ServerId },
    payload: ServerInput,
    success: ServerView,
    error: writeErrors,
  }),
  HttpApiEndpoint.delete("deleteServer", "/servers/:id", {
    params: { id: ServerId },
    success: HttpApiSchema.NoContent,
    error: writeErrors,
  }),
  HttpApiEndpoint.post("testServerConnection", "/servers/:id/test", {
    params: { id: ServerId },
    success: ConnectionTestView,
    error: upstreamErrors,
  }),
  HttpApiEndpoint.get("getServerHealth", "/servers/:id/health", {
    params: { id: ServerId },
    success: ServerHealthView,
    error: readErrors,
  }),
  HttpApiEndpoint.get("listSourceLibraries", "/servers/:id/libraries", {
    params: { id: ServerId },
    success: Schema.Array(SourceLibraryView),
    error: [Unauthorized, NotFound, UpstreamUnavailable, UpstreamRejected, Timeout, Internal],
  }),
);

const libraries = HttpApiGroup.make("libraries").add(
  HttpApiEndpoint.get("listVirtualLibraries", "/libraries", {
    success: Schema.Array(VirtualLibraryView),
    error: [Unauthorized, Internal],
  }),
  HttpApiEndpoint.post("createVirtualLibrary", "/libraries", {
    payload: VirtualLibraryInput,
    success: VirtualLibraryView,
    error: writeErrors,
  }),
  HttpApiEndpoint.get("getVirtualLibrary", "/libraries/:id", {
    params: { id: VirtualLibraryId },
    success: VirtualLibraryView,
    error: readErrors,
  }),
  HttpApiEndpoint.put("updateVirtualLibrary", "/libraries/:id", {
    params: { id: VirtualLibraryId },
    payload: VirtualLibraryInput,
    success: VirtualLibraryView,
    error: writeErrors,
  }),
  HttpApiEndpoint.delete("deleteVirtualLibrary", "/libraries/:id", {
    params: { id: VirtualLibraryId },
    success: HttpApiSchema.NoContent,
    error: writeErrors,
  }),
);

const system = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("getSystemStatus", "/system", {
    success: SystemStatusView,
    error: [Unauthorized, Internal],
  }),
  HttpApiEndpoint.get("listOutboxFailures", "/system/outbox-failures", {
    success: Schema.Array(OutboxFailureView),
    error: [Unauthorized, Internal],
  }),
  HttpApiEndpoint.get("getMetadataSettings", "/metadata-settings", {
    success: MetadataProviderSettingsView,
    error: [Unauthorized, Internal],
  }),
  HttpApiEndpoint.put("updateMetadataSettings", "/metadata-settings", {
    payload: MetadataProviderSettingsInput,
    success: MetadataProviderSettingsView,
    error: writeErrors,
  }),
);

export const DashboardApi = HttpApi.make("DashboardApi")
  .add(bootstrap, auth, servers, libraries, system)
  .prefix("/api/dashboard");
