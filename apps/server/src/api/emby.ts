import { Effect, Result, Schema } from "effect";
import { getLogger } from "@logtape/logtape";

import type { AuthService } from "../core/auth.js";
import { InvalidCredentials } from "../core/errors.js";
import type {
  CanonicalItemView,
  CatalogFilter,
  FederatedQuery,
  FederationService,
  SortTerm,
} from "../core/federation.js";
import type { LibraryServiceApi } from "../core/library-service.js";
import type { DrivembyCompat, ItemFlags } from "../core/drivemby-compat.js";
import { decodeHistoryCursor } from "../core/drivemby-compat.js";
import type { JsonValue, PlaybackEvent, UserStatePatch, UserStateRecord } from "../core/model.js";
import {
  serveRegisteredResource,
  type ImageSelection,
  type PlaybackInfo,
  type ResourceDecision,
  type SubtitleSelection,
  type VideoSelection,
} from "../core/playback.js";
import type { ResourceCacheService } from "../core/resource-cache.js";
import type { UserStateService } from "../core/user-state.js";
import {
  EmbyClient,
  type EmbyItemDto as EmbyItemDtoValue,
  EmbyItemsQuery,
  EmbyLoginBody,
  type EmbyMediaSourceDto as EmbyMediaSourceDtoValue,
  type EmbyMediaStreamDto as EmbyMediaStreamDtoValue,
  EmbyPlaybackEvent,
  EmbyPlaybackRequest,
  type EmbyPlaybackInfoDto as EmbyPlaybackInfoDtoValue,
  EmbyUserDataPatch,
  type EmbyItemsQuery as EmbyItemsQueryValue,
  type EmbyPlaybackEvent as EmbyPlaybackEventValue,
  type EmbyUserDataPatch as EmbyUserDataPatchValue,
} from "./emby-schemas.js";

export interface PlaybackInfoBoundary {
  readonly playSessionId: string;
  readonly mediaSources: ReadonlyArray<JsonValue>;
}

/** Task 10 supplies this service. This protocol layer only delegates and maps casing. */
export interface PlaybackBoundary {
  readonly getInfo: (
    canonicalId: string,
    clientUserAgent?: string,
  ) => Effect.Effect<PlaybackInfoBoundary, unknown>;
  readonly resolveVideoRedirect?: (input: VideoSelection) => Effect.Effect<URL, unknown>;
  readonly resolveImage?: (input: ImageSelection) => Effect.Effect<ResourceDecision, unknown>;
  readonly resolveSubtitle?: (input: SubtitleSelection) => Effect.Effect<ResourceDecision, unknown>;
}

export interface EmbyServices {
  readonly config: {
    readonly serverId: string;
    readonly serverName: string;
    readonly version: string;
  };
  readonly now: () => number;
  readonly auth: Pick<AuthService, "loginEmby" | "authenticateEmby"> &
    Partial<Pick<AuthService, "authenticateDashboard" | "issueEmbySession">>;
  readonly federation: Pick<
    FederationService,
    "list" | "search" | "studios" | "detail" | "lookupMembership"
  > &
    Partial<Pick<FederationService, "showChildren">>;
  readonly compat?: DrivembyCompat;
  readonly userState: Pick<UserStateService, "write" | "recordPlaybackEvent">;
  readonly libraries: Pick<LibraryServiceApi, "list">;
  readonly playback: PlaybackBoundary;
  readonly resourceCache?: ResourceCacheService;
}

class InvalidEmbyRequest extends Schema.TaggedError<InvalidEmbyRequest>()(
  "InvalidEmbyRequest",
  {},
) {}
class EmbyNotFound extends Schema.TaggedError<EmbyNotFound>()("EmbyNotFound", {}) {}
class EmbyForbidden extends Schema.TaggedError<EmbyForbidden>()("EmbyForbidden", {}) {}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

const failure = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status);

const notFound = (): Response => failure(404, "NotFound", "Resource not found");

const failureTag = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Internal";

const publicFailure = (error: unknown): Response => {
  const tag = failureTag(error);
  switch (tag) {
    case "InvalidEmbyRequest":
      return failure(400, "InvalidRequest", "Invalid request");
    case "FederationLimitExceeded":
      return failure(400, "InvalidRequest", "Invalid request");
    case "InvalidCredentials":
      return failure(401, "Unauthorized", "Authentication required");
    case "EmbyForbidden":
      return failure(403, "Forbidden", "Forbidden");
    case "EmbyNotFound":
    case "PlaybackNotFound":
    case "ResourceRejected":
    case "LibraryNotFound":
    case "ServerNotFound":
      return notFound();
    case "RateLimited":
      return failure(429, "RateLimited", "Too many authentication attempts");
    case "FederationUnavailable":
    case "UpstreamUnavailable":
    case "UpstreamTimeout":
    case "UpstreamRejected":
      return failure(503, "Unavailable", "Service unavailable");
    case "PlaybackUnavailable":
    case "ResourceCacheError":
    case "ResourceUnavailable":
      return failure(503, "Unavailable", "Service unavailable");
    case "ResourceTimeout":
      return failure(504, "Timeout", "Upstream request timed out");
    case "ResourceTooLarge":
      return failure(413, "TooLarge", "Resource is too large");
    case "ResourceInvalidResponse":
      return failure(502, "InvalidResponse", "Invalid upstream response");
    default:
      return failure(500, "Internal", "Internal server error");
  }
};

const decode = <A>(
  schema: Schema.Schema<A>,
  input: unknown,
): Effect.Effect<A, InvalidEmbyRequest> => {
  const run = Schema.decodeUnknownEffect(schema) as (value: unknown) => Effect.Effect<A, unknown>;
  return run(input).pipe(Effect.mapError(() => new InvalidEmbyRequest()));
};

const readJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new InvalidEmbyRequest(),
  });

const split = (value: string | null): ReadonlyArray<string> | undefined =>
  value === null ? undefined : value.split(",").map((entry) => entry.trim());

const embyLogger = getLogger(["oh-my-emby", "emby"]);
const sensitiveQueryParameter =
  /(?:^|[_-])(?:access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|credential|password|pass|pwd|pw|secret|signature|sig|token|jwt|session|cookie|key|hash)(?:$|[_-])/i;
const privateQueryParameter = /^(?:q|query|search(?:[_-]?term)?)$/i;

const queryAudit = (url: URL) => {
  const queryKeys = [...new Set(url.searchParams.keys())].sort();
  return {
    queryKeys: queryKeys.filter((key) => !sensitiveQueryParameter.test(key)),
    query: Object.fromEntries(
      queryKeys.map((key) => [
        key,
        sensitiveQueryParameter.test(key) || privateQueryParameter.test(key)
          ? ["[redacted]"]
          : url.searchParams.getAll(key),
      ]),
    ),
    hasParentId: url.searchParams.has("ParentId"),
    hasSensitiveQuery: queryKeys.some((key) => sensitiveQueryParameter.test(key)),
  };
};

const requestAudit = (request: Request) => {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname,
    userAgent: request.headers.get("user-agent") ?? undefined,
    ...queryAudit(url),
    hasParentId: url.searchParams.has("ParentId"),
  };
};

const redirectAudit = (request: Request, response: Response) => {
  const location = response.headers.get("location");
  if (location === null) return { protocol: "missing" };
  try {
    const url = new URL(location, request.url);
    return {
      protocol: url.protocol,
      ...(url.protocol === "http:" || url.protocol === "https:" ? { origin: url.origin } : {}),
      path: url.pathname,
      ...queryAudit(url),
    };
  } catch {
    return { protocol: "invalid" };
  }
};

const logRequest = (
  request: Request,
  response: Response,
  startedAt: number,
  error?: unknown,
): void => {
  const redirect =
    response.status >= 300 && response.status < 400 ? redirectAudit(request, response) : undefined;
  const properties = {
    ...requestAudit(request),
    ...(redirect === undefined ? {} : { redirect }),
    status: response.status,
    durationMs: Date.now() - startedAt,
  };
  if (error === undefined) {
    embyLogger.info(
      `Emby request {method} {path} ua={userAgent} keys={queryKeys} query={query} parent={hasParentId} ` +
        `sensitiveQuery={hasSensitiveQuery}${redirect === undefined ? "" : " redirect={redirect}"} ` +
        "completed with {status} in {durationMs}ms",
      properties,
    );
    return;
  }
  embyLogger.warn(
    `Emby request {method} {path} ua={userAgent} keys={queryKeys} query={query} parent={hasParentId} ` +
      `sensitiveQuery={hasSensitiveQuery}${redirect === undefined ? "" : " redirect={redirect}"} ` +
      "failed with {status} ({failure}) in {durationMs}ms",
    { ...properties, failure: failureTag(error) },
  );
};

const number = (value: string | null): number | undefined =>
  value === null ? undefined : value.trim() === "" ? Number.NaN : Number(value);

const booleanQuery = (value: string | null): boolean | undefined => {
  if (value === null || value.trim() === "") return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return Number.NaN as unknown as boolean;
};

const compact = <A extends Record<string, unknown>>(value: A): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

const decodeItemsQuery = (url: URL) =>
  decode(
    EmbyItemsQuery,
    compact({
      ParentId: url.searchParams.get("ParentId") ?? undefined,
      StartIndex: number(url.searchParams.get("StartIndex")),
      Limit: number(url.searchParams.get("Limit")),
      SearchTerm: url.searchParams.get("SearchTerm") ?? undefined,
      SortBy: split(url.searchParams.get("SortBy")),
      SortOrder: split(url.searchParams.get("SortOrder")),
      Fields: split(url.searchParams.get("Fields")),
      Studios: url.searchParams
        .get("Studios")
        ?.split("|")
        .map((name) => name.trim()),
      StudioIds: split(url.searchParams.get("StudioIds")),
      Filters: split(url.searchParams.get("Filters")),
      IncludeItemTypes: split(url.searchParams.get("IncludeItemTypes")),
      IsWatchlisted: booleanQuery(url.searchParams.get("IsWatchlisted")),
    }),
  ).pipe(
    Effect.flatMap((query) => {
      if ((query.SortOrder?.length ?? 0) > 1 && query.SortOrder?.length !== query.SortBy?.length) {
        return Effect.fail(new InvalidEmbyRequest());
      }
      return Effect.try({
        try: () => {
          const names = [
            ...(query.Studios ?? []),
            ...(query.StudioIds ?? []).map((id) => {
              if (!id.startsWith("studio:")) throw new InvalidEmbyRequest();
              const name = decodeURIComponent(id.slice(7)).trim();
              if (!name) throw new InvalidEmbyRequest();
              return name;
            }),
          ];
          return names.length === 0
            ? query
            : {
                ...query,
                Studios: [...new Set(names.map((name) => name.toLowerCase()))],
              };
        },
        catch: () => new InvalidEmbyRequest(),
      });
    }),
  );

const parseAuthorization = (value: string | null): Readonly<Record<string, string>> => {
  if (!value) return {};
  const input = value.replace(/^\s*(?:MediaBrowser|Emby)\s+/i, "");
  const entries: Array<[string, string]> = [];
  for (const match of input.matchAll(
    /(?:^|,\s*)([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g,
  )) {
    entries.push([match[1]!.toLowerCase(), match[2] ?? match[3] ?? ""]);
  }
  return Object.fromEntries(entries);
};

const token = (request: Request, url: URL): string | null => {
  const direct = request.headers.get("x-emby-token") ?? url.searchParams.get("api_key");
  if (direct?.trim()) return direct.trim();
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^\s*Bearer\s+(.+?)\s*$/i)?.[1];
  if (bearer) return bearer;
  return (
    parseAuthorization(authorization).token ??
    parseAuthorization(request.headers.get("x-emby-authorization")).token ??
    null
  );
};

const client = (request: Request) => {
  const values = {
    ...parseAuthorization(request.headers.get("authorization")),
    ...parseAuthorization(request.headers.get("x-emby-authorization")),
  };
  return decode(EmbyClient, { Device: values.device, DeviceId: values.deviceid });
};

const pathSegment = (value: string): Effect.Effect<string, InvalidEmbyRequest> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.NonEmptyString)(decodeURIComponent(value)),
    catch: () => new InvalidEmbyRequest(),
  });

const normalizedPath = (pathname: string): string => {
  let path =
    pathname === "/emby" ? "/" : pathname.startsWith("/emby/") ? pathname.slice(5) : pathname;
  if (
    path === "/api/me" ||
    path.startsWith("/api/me/") ||
    path === "/api/watch" ||
    path.startsWith("/api/watch/")
  ) {
    path = path.slice(4);
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
};

const object = (value: JsonValue): Readonly<Record<string, JsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : {};

const userData = (state: UserStateRecord | null, itemId: string) => ({
  ItemId: itemId,
  Played: state?.played ?? false,
  IsFavorite: state?.favorite ?? false,
  PlayCount: state?.playCount ?? 0,
  PlaybackPositionTicks: state?.positionTicks ?? 0,
});

const scalar = (value: JsonValue | undefined): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const pickScalars = (
  source: Readonly<Record<string, JsonValue>>,
  keys: ReadonlyArray<string>,
): Record<string, string | number | boolean> =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return scalar(value) ? [[key, value]] : [];
    }),
  );

const itemScalarFields = [
  "Name",
  "OriginalTitle",
  "SortName",
  "Overview",
  "ProductionYear",
  "PremiereDate",
  "DateCreated",
  "EndDate",
  "CommunityRating",
  "CriticRating",
  "OfficialRating",
  "RunTimeTicks",
  "IndexNumber",
  "ParentIndexNumber",
  "ChildCount",
  "IsFolder",
  "IsHD",
] as const;

const mediaSourceScalarFields = [
  "Protocol",
  "Container",
  "Size",
  "RunTimeTicks",
  "Bitrate",
  "VideoType",
  "SupportsDirectPlay",
  "SupportsDirectStream",
  "SupportsTranscoding",
  "IsRemote",
] as const;

const mediaStreamScalarFields = [
  "Index",
  "Type",
  "Codec",
  "CodecTag",
  "Language",
  "DisplayTitle",
  "Title",
  "Profile",
  "Level",
  "AspectRatio",
  "PixelFormat",
  "VideoRange",
  "ChannelLayout",
  "SampleRate",
  "Channels",
  "BitRate",
  "BitDepth",
  "Width",
  "Height",
  "AverageFrameRate",
  "RealFrameRate",
  "IsDefault",
  "IsForced",
  "IsExternal",
  "IsTextSubtitleStream",
  "IsInterlaced",
  "IsAVC",
  "IsAnamorphic",
  "SupportsExternalStream",
] as const;

const mediaStreamDto = (value: JsonValue): EmbyMediaStreamDtoValue | null => {
  const stream = pickScalars(object(value), mediaStreamScalarFields);
  return Object.keys(stream).length === 0 ? null : (stream as EmbyMediaStreamDtoValue);
};

const mediaSourceDto = (
  value: JsonValue,
  identity?: { readonly id: string; readonly name: string; readonly streams: JsonValue },
): EmbyMediaSourceDtoValue | null => {
  const source = object(value);
  const id = identity?.id ?? (typeof source.Id === "string" ? source.Id : "");
  if (!id) return null;
  const name = identity?.name ?? (typeof source.Name === "string" ? source.Name : undefined);
  const streams = identity?.streams ?? source.MediaStreams;
  return {
    ...pickScalars(source, mediaSourceScalarFields),
    Id: id,
    ...(name ? { Name: name } : {}),
    MediaStreams: Array.isArray(streams)
      ? streams.flatMap((entry) => {
          const mapped = mediaStreamDto(entry);
          return mapped === null ? [] : [mapped];
        })
      : [],
  } as EmbyMediaSourceDtoValue;
};

const streamPath = (canonicalId: string, mediaSourceId: string) =>
  `/Videos/${encodeURIComponent(canonicalId)}/stream?MediaSourceId=${encodeURIComponent(mediaSourceId)}`;

const imageTagTypes = (metadata: Readonly<Record<string, JsonValue>>) =>
  Object.fromEntries(
    Object.entries(object(metadata.ImageTags ?? null)).flatMap(([type, tag]) =>
      /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(type) && typeof tag === "string" && tag.length > 0
        ? [[type, "local"]]
        : [],
    ),
  );

const backdropImageTags = (metadata: Readonly<Record<string, JsonValue>>) =>
  Array.isArray(metadata.BackdropImageTags)
    ? metadata.BackdropImageTags.flatMap((tag) =>
        typeof tag === "string" && tag.length > 0 ? ["local"] : [],
      )
    : [];

const externalImageTags = (metadata: Readonly<Record<string, JsonValue>>) => {
  const images = object(metadata.ExternalImages ?? null);
  return {
    primary: typeof images.Primary === "string" && images.Primary.length > 0,
    backdrops: Array.isArray(images.Backdrop)
      ? images.Backdrop.flatMap((image, index) =>
          typeof image === "string" && image.length > 0 ? [`external-${index}`] : [],
        )
      : [],
  };
};

const itemDto = (item: CanonicalItemView, serverId: string): EmbyItemDtoValue => {
  const metadata = object(item.displayMetadata);
  const upstreamImageTags = imageTagTypes(metadata);
  const upstreamBackdrops = backdropImageTags(metadata);
  const external = externalImageTags(metadata);
  const imageTags =
    external.primary && upstreamImageTags.Primary === undefined
      ? { ...upstreamImageTags, Primary: "external" }
      : upstreamImageTags;
  const backdrops = upstreamBackdrops.length > 0 ? upstreamBackdrops : external.backdrops;
  return {
    ...pickScalars(metadata, itemScalarFields),
    Id: item.id,
    ServerId: serverId,
    Type: item.itemType,
    ...(Object.keys(imageTags).length > 0 ? { ImageTags: imageTags } : {}),
    ...(backdrops.length > 0 ? { BackdropImageTags: backdrops } : {}),
    ...(Array.isArray(metadata.Genres) &&
    metadata.Genres.every((entry) => typeof entry === "string" && entry.length > 0)
      ? { Genres: metadata.Genres }
      : {}),
    UserData: userData(item.userState, item.id),
    MediaSources: item.mediaVersions.flatMap((version) => {
      const mapped = mediaSourceDto(version.capabilities, {
        id: version.id,
        name: version.label,
        streams: version.streams,
      });
      if (mapped === null) return [];
      const path = streamPath(item.id, version.id);
      return [{ ...mapped, Path: path, DirectStreamUrl: path }];
    }),
  } as EmbyItemDtoValue;
};

const safeVideoPath = (value: JsonValue | undefined): string | null =>
  typeof value === "string" && /^\/Videos\/[^/?#]+\/stream\?MediaSourceId=[^&#]+$/.test(value)
    ? value
    : null;

const safeSubtitlePath = (value: JsonValue | undefined): string | null =>
  typeof value === "string" &&
  /^\/Videos\/[^/?#]+\/[^/?#]+\/Subtitles\/\d+\/Stream\.(?:srt|vtt|ass|ssa|ttml)$/.test(value)
    ? value
    : null;

const playbackInfoDto = (info: PlaybackInfoBoundary | PlaybackInfo): EmbyPlaybackInfoDtoValue => ({
  PlaySessionId: info.playSessionId,
  MediaSources: info.mediaSources.flatMap((source) => {
    const mapped = mediaSourceDto(source);
    if (mapped === null) return [];
    const raw = object(source);
    const path = safeVideoPath(raw.Path) ?? safeVideoPath(raw.DirectStreamUrl);
    const streams = Array.isArray(raw.MediaStreams)
      ? raw.MediaStreams.flatMap((entry) => {
          const publicStream = mediaStreamDto(entry);
          if (publicStream === null) return [];
          const deliveryUrl = safeSubtitlePath(object(entry).DeliveryUrl);
          return [
            { ...publicStream, ...(deliveryUrl === null ? {} : { DeliveryUrl: deliveryUrl }) },
          ];
        })
      : [];
    return [
      {
        ...mapped,
        ...(path === null ? {} : { Path: path, DirectStreamUrl: path }),
        MediaStreams: streams,
      } as EmbyMediaSourceDtoValue,
    ];
  }),
});

const redirect = (location: URL): Response =>
  new Response(null, {
    status: 302,
    headers: { location: location.href, "cache-control": "private, no-store" },
  });

const filter = (name: NonNullable<EmbyItemsQueryValue["Filters"]>[number]): CatalogFilter => {
  switch (name) {
    case "IsFavorite":
      return { field: "favorite", value: true };
    case "IsPlayed":
      return { field: "played", value: true };
    case "IsUnplayed":
      return { field: "played", value: false };
    case "IsResumable":
      return { field: "resume", value: true };
  }
};

const query = (
  principal: { readonly username: string; readonly deviceId: string },
  input: EmbyItemsQueryValue,
): FederatedQuery => {
  const orders = input.SortOrder ?? [];
  const sort: ReadonlyArray<SortTerm> = (input.SortBy ?? []).map((field, index) => ({
    field,
    direction: orders[index] ?? orders[0] ?? "Ascending",
  }));
  return {
    userId: principal.username,
    deviceId: principal.deviceId,
    virtualLibraryId: input.ParentId ?? null,
    startIndex: input.StartIndex ?? 0,
    limit: input.Limit ?? 100,
    sort,
    filters: [
      ...(input.Filters ?? []).map(filter),
      ...(input.Studios === undefined ? [] : [{ field: "Studios", value: input.Studios }]),
    ],
    itemTypes: [...new Set(input.IncludeItemTypes ?? [])],
    ...(input.Fields === undefined ? {} : { fields: input.Fields }),
  };
};

const principalFor = (services: EmbyServices, request: Request, url: URL) => {
  const value = token(request, url);
  return value
    ? decode(Schema.NonEmptyString, value).pipe(Effect.flatMap(services.auth.authenticateEmby))
    : Effect.fail(new InvalidCredentials());
};

const requireUser = <A extends { readonly username: string }>(principal: A, encoded: string) =>
  pathSegment(encoded).pipe(
    Effect.flatMap((userId) =>
      userId === principal.username ? Effect.succeed(userId) : Effect.fail(new EmbyForbidden()),
    ),
  );

const statePatch = (
  body: EmbyUserDataPatchValue,
): Effect.Effect<UserStatePatch, InvalidEmbyRequest> => {
  const patch: UserStatePatch = {
    ...(body.Played === undefined ? {} : { played: body.Played }),
    ...(body.IsFavorite === undefined ? {} : { favorite: body.IsFavorite }),
    ...(body.PlayCount === undefined ? {} : { playCount: body.PlayCount }),
    ...(body.PlaybackPositionTicks === undefined
      ? {}
      : { positionTicks: body.PlaybackPositionTicks }),
    ...(body.LastPlayedVersionId === undefined
      ? {}
      : { lastPlayedVersionId: body.LastPlayedVersionId }),
  };
  return Object.keys(patch).length === 0
    ? Effect.fail(new InvalidEmbyRequest())
    : Effect.succeed(patch);
};

const playbackEvent = (
  kind: PlaybackEvent["kind"],
  body: EmbyPlaybackEventValue,
  canonicalId: string,
  versionId: string,
  now: number,
  played: boolean,
): PlaybackEvent =>
  ({
    kind,
    localSessionId: body.PlaySessionId,
    canonicalId,
    versionId,
    positionTicks: body.PositionTicks ?? 0,
    occurredAtMs: now,
    ...(kind === "stop" ? { played } : {}),
  }) as PlaybackEvent;

const serverInfo = (services: EmbyServices) => ({
  Id: services.config.serverId,
  ServerName: services.config.serverName,
  ProductName: "oh-my-emby",
  Version: services.config.version,
  OperatingSystem: "Unknown",
  StartupWizardCompleted: true,
});

const user = (services: EmbyServices, userId: string) => ({
  Id: userId,
  Name: userId,
  ServerId: services.config.serverId,
  HasPassword: true,
  HasConfiguredPassword: true,
  Configuration: {},
  Policy: { IsAdministrator: true, IsDisabled: false },
});

const defaultUserLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#00c950" d="M391.915 157.252c10.723-7.791 13.201-22.924 4.134-32.592a192 192 0 0 0-227.215-39.733 192 192 0 0 0-52.883 39.733c-9.067 9.668-6.589 24.801 4.134 32.592s25.611 5.235 35.073-4.047A144 144 0 0 1 256 112a144 144 0 0 1 100.842 41.205c9.462 9.282 24.349 11.838 35.073 4.047"/><path fill="#262626" d="M105.003 182.354c-11.914-5.811-26.439-.894-30.719 11.651a191.995 191.995 0 0 0 71.589 219.272 192 192 0 0 0 59.909 28.039c12.794 3.467 24.992-5.825 26.837-18.951s-7.401-25.07-20.039-29.067a143.987 143.987 0 0 1-83.724-69.694 144 144 0 0 1-10.961-108.383c3.753-12.712-.979-27.057-12.892-32.867"/><path fill="#737373" d="M276.474 422.748c1.615 13.156 13.65 22.66 26.502 19.417a192.02 192.02 0 0 0 120.951-93.082 191.98 191.98 0 0 0 14.843-151.897c-4.06-12.618-18.497-17.788-30.51-12.186s-16.995 19.862-13.464 32.637a144 144 0 0 1-12.851 108.176 144 144 0 0 1-84.928 68.222c-12.705 3.775-22.158 15.557-20.543 28.713"/><path fill="#00c950" d="M328 242.144c10.667 6.158 10.667 21.554 0 27.712l-96 55.426c-10.667 6.158-24-1.54-24-13.856V200.574c0-12.316 13.333-20.014 24-13.856z"/></svg>`;
const defaultUserLogoBytes = new TextEncoder().encode(defaultUserLogo);

const loadFlags = (services: EmbyServices, ids: ReadonlyArray<string>) =>
  services.compat === undefined || ids.length === 0
    ? Effect.succeed(new Map<string, ItemFlags>())
    : services.compat.flagsFor(ids);

const paintItem = (
  services: EmbyServices,
  dto: EmbyItemDtoValue,
  flags: ReadonlyMap<string, ItemFlags>,
) =>
  services.compat === undefined
    ? dto
    : {
        ...dto,
        UserData: {
          ...dto.UserData,
          IsWatchlisted: flags.get(dto.Id)?.watchlisted ?? false,
        },
      };

const paintUserData = (
  services: EmbyServices,
  state: UserStateRecord | null,
  itemId: string,
  flags: ReadonlyMap<string, ItemFlags>,
) => {
  const data = userData(state, itemId);
  return services.compat === undefined
    ? data
    : { ...data, IsWatchlisted: flags.get(itemId)?.watchlisted ?? false };
};

const pageBounds = (url: URL, fallbackLimit = 50) => {
  const start = number(url.searchParams.get("StartIndex")) ?? 0;
  const limit = number(url.searchParams.get("Limit")) ?? fallbackLimit;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return null;
  }
  return { start, limit };
};

const isoTime = (ms: number) => new Date(ms).toISOString();

const parseTimestamp = (value: unknown): number | null => {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const percentage = (position: number, runtime: number | null) =>
  runtime !== null && runtime > 0
    ? Math.min(100, Math.max(0, (position / runtime) * 100))
    : undefined;

const withoutBody = (response: Response): Response =>
  new Response(null, { status: response.status, headers: response.headers });

const agree = (left: string | null | undefined, right: string | null | undefined) =>
  left == null || left === "" || right == null || right === "" || left === right;

const readOptionalJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.text(),
    catch: () => new InvalidEmbyRequest(),
  }).pipe(
    Effect.flatMap((text) =>
      text.trim() === ""
        ? Effect.succeed({})
        : Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => new InvalidEmbyRequest(),
          }),
    ),
  );

const isConsolePath = (path: string) =>
  path === "/me/emby-connections" ||
  path.startsWith("/me/emby-connections/") ||
  path === "/watch/history" ||
  path.startsWith("/watch/history/");

const interruptWhenAborted = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback((resume) => {
    const abort = () => resume(Effect.interrupt);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

const consoleBearer = (request: Request): string | null =>
  request.headers.get("authorization")?.match(/^\s*Bearer\s+(\S+)\s*$/i)?.[1] ?? null;

const connectionJson = (connection: {
  readonly id: string;
  readonly name: string;
  readonly password: string;
  readonly createdAtMs: number;
}) => ({
  id: connection.id,
  name: connection.name,
  password: connection.password,
  createdAt: isoTime(connection.createdAtMs),
});

const consoleRequest = (
  services: EmbyServices,
  request: Request,
  path: string,
  url: URL,
): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    const token = consoleBearer(request);
    if (token === null || services.auth.authenticateDashboard === undefined) {
      return yield* Effect.fail(new InvalidCredentials());
    }
    const principal = yield* services.auth.authenticateDashboard(token);
    if (services.compat === undefined) return failure(500, "Internal", "Internal server error");
    const compat = services.compat;
    if (path === "/me/emby-connections" && methodOf(request) === "POST") {
      const body = yield* readJson(request);
      const name = typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
      const password =
        typeof body === "object" && body !== null && "password" in body ? body.password : undefined;
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 80) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      if (
        password !== undefined &&
        (typeof password !== "string" || password.length < 6 || password.length > 128)
      ) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const created = yield* compat.createConnection({
        name: name.trim(),
        password: typeof password === "string" ? password : null,
        nowMs: services.now(),
      });
      if (created === null) return yield* Effect.fail(new InvalidEmbyRequest());
      return json(connectionJson(created));
    }
    if (path === "/me/emby-connections" && methodOf(request) === "GET") {
      return json({
        serverUrl: new URL(request.url).origin,
        username: principal.username,
        credentials: (yield* compat.listConnections()).map((connection) => ({
          id: connection.id,
          name: connection.name,
          createdAt: isoTime(connection.createdAtMs),
          devices: connection.devices.map((device) => ({
            id: device.id,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            lastUsedAt: isoTime(device.lastUsedAtMs),
          })),
        })),
      });
    }
    const connectionId = path.match(/^\/me\/emby-connections\/([^/]+)$/);
    if (connectionId && methodOf(request) === "PATCH") {
      const body = yield* readOptionalJson(request);
      const password =
        typeof body === "object" && body !== null && "password" in body
          ? (body as { password?: unknown }).password
          : undefined;
      if (
        password !== undefined &&
        (typeof password !== "string" || password.length < 6 || password.length > 128)
      ) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const updated = yield* compat.updateConnection({
        id: yield* pathSegment(connectionId[1]!),
        password: typeof password === "string" ? password : null,
        nowMs: services.now(),
      });
      if (updated === null) return yield* Effect.fail(new EmbyNotFound());
      return json(connectionJson(updated));
    }
    if (connectionId && methodOf(request) === "DELETE") {
      const removed = yield* compat.deleteConnection(
        yield* pathSegment(connectionId[1]!),
        services.now(),
      );
      if (!removed) return yield* Effect.fail(new EmbyNotFound());
      return json({ ok: true });
    }
    if (path === "/watch/history" && methodOf(request) === "GET") {
      const limit = number(url.searchParams.get("limit")) ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const cursorRaw = url.searchParams.get("cursor");
      const cursor = cursorRaw === null || cursorRaw === "" ? null : decodeHistoryCursor(cursorRaw);
      if (cursorRaw !== null && cursorRaw !== "" && cursor === null) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const listed = yield* compat.listHistory({
        cursor,
        startIndex: 0,
        limit,
        search: url.searchParams.get("search"),
        itemId: null,
      });
      return json({
        items: listed.items.map((entry) => ({
          id: entry.id,
          itemId: entry.canonicalId,
          itemName: entry.itemName,
          startedAt: isoTime(entry.startedAtMs),
          stoppedAt: entry.stoppedAtMs === null ? null : isoTime(entry.stoppedAtMs),
          positionTicks: entry.positionTicks,
          durationTicks: entry.runtimeTicks,
          mediaSourceId: entry.mediaSourceId,
          completed: entry.completed,
        })),
        total: listed.total,
        nextCursor: listed.nextCursor,
      });
    }
    if (path === "/watch/history/clear" && methodOf(request) === "POST") {
      const body = yield* readJson(request);
      const before = parseTimestamp(
        typeof body === "object" && body !== null && "before" in body
          ? (body as { before?: unknown }).before
          : undefined,
      );
      if (before === null) return yield* Effect.fail(new InvalidEmbyRequest());
      return json({ ok: true, deleted: yield* compat.clearHistory(before) });
    }
    const historyId = path.match(/^\/watch\/history\/([^/]+)$/);
    if (historyId && historyId[1] !== "clear" && methodOf(request) === "DELETE") {
      const removed = yield* compat.deleteHistory(yield* pathSegment(historyId[1]!));
      if (!removed) return yield* Effect.fail(new EmbyNotFound());
      return json({ ok: true });
    }
    return notFound();
  });

const methodOf = (request: Request) => request.method.toUpperCase();

const handle = (services: EmbyServices, request: Request): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const path = normalizedPath(url.pathname);
    const method = request.method.toUpperCase();
    const clientUserAgent = request.headers.get("user-agent") ?? undefined;

    if (method === "GET" && path === "/System/Info/Public") return json(serverInfo(services));
    if (method === "GET" && path === "/Users/Public") return json([]);

    if (method === "POST" && path === "/Users/AuthenticateByName") {
      const metadata = yield* client(request);
      const body = yield* readJson(request).pipe(
        Effect.flatMap((value) => decode(EmbyLoginBody, value)),
      );
      const password = body.Pw ?? body.Password;
      if (password === undefined) return yield* Effect.fail(new InvalidEmbyRequest());
      const attempted = yield* services.auth
        .loginEmby(
          {
            username: body.Username,
            password,
            deviceId: metadata.DeviceId,
            deviceName: metadata.Device,
          },
          { scopeKey: `emby:${body.Username}` },
        )
        .pipe(Effect.result);
      if (Result.isSuccess(attempted)) {
        return json({
          AccessToken: attempted.success.accessToken,
          ServerId: services.config.serverId,
          User: user(services, attempted.success.userId),
        });
      }
      if (failureTag(attempted.failure) !== "InvalidCredentials") {
        return yield* Effect.fail(attempted.failure);
      }
      const connectionId =
        services.compat === undefined ? null : yield* services.compat.verifyConnection(password);
      if (connectionId !== null && services.auth.issueEmbySession !== undefined) {
        const session = yield* services.auth.issueEmbySession({
          username: body.Username,
          password,
          deviceId: metadata.DeviceId,
          deviceName: metadata.Device,
        });
        if (session.tokenId !== undefined && services.compat !== undefined) {
          yield* services.compat.linkConnectionDevice(connectionId, session.tokenId);
        }
        return json({
          AccessToken: session.accessToken,
          ServerId: services.config.serverId,
          User: user(services, session.userId),
        });
      }
      return yield* Effect.fail(attempted.failure);
    }

    if (isConsolePath(path)) return yield* consoleRequest(services, request, path, url);

    const system = method === "GET" && path === "/System/Info";
    const virtualFolders = method === "GET" && path === "/Library/VirtualFolders";
    const displayPreferences =
      method === "GET" ? path.match(/^\/DisplayPreferences\/([^/]+)$/) : null;
    const userProfile =
      method === "GET" && path !== "/Users/Public" ? path.match(/^\/Users\/([^/]+)$/) : null;
    const views = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Views$/) : null;
    const userItems = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Items$/) : null;
    const latestItems = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Items\/Latest$/) : null;
    const resumeItems = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Items\/Resume$/) : null;
    const studios = method === "GET" && path === "/Studios";
    const allItems = method === "GET" && path === "/Items";
    const userDetail = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Items\/([^/]+)$/) : null;
    const itemCounts = method === "GET" && path === "/Items/Counts";
    const genres = method === "GET" && path === "/Genres";
    const itemDetail =
      method === "GET" && path !== "/Items/Counts" ? path.match(/^\/Items\/([^/]+)$/) : null;
    const similar = method === "GET" ? path.match(/^\/Items\/([^/]+)\/Similar$/) : null;
    const userDataRoute =
      method === "POST" ? path.match(/^\/Users\/([^/]+)\/Items\/([^/]+)\/UserData$/) : null;
    const favorite = path.match(/^\/Users\/([^/]+)\/FavoriteItems\/([^/]+)$/);
    const played = path.match(/^\/Users\/([^/]+)\/PlayedItems\/([^/]+)$/);
    const playbackInfo =
      method === "GET" || method === "POST"
        ? path.match(/^\/Items\/([^/]+)\/PlaybackInfo$/)
        : null;
    const videoStream =
      method === "GET" || method === "HEAD"
        ? path.match(/^\/Videos\/([^/]+)\/stream(?:\.[^/]+)?$/)
        : null;
    const videoDownload =
      method === "GET" || method === "HEAD" ? path.match(/^\/Items\/([^/]+)\/Download$/) : null;
    const image =
      method === "GET" || method === "HEAD"
        ? path.match(/^\/Items\/([^/]+)\/Images\/([^/]+)(?:\/(\d+))?$/)
        : null;
    const userImage =
      method === "GET" || method === "HEAD"
        ? path.match(/^\/Users\/([^/]+)\/Images\/([^/]+)(?:\/(\d+))?$/)
        : null;
    const subtitle =
      method === "GET"
        ? path.match(/^\/Videos\/([^/]+)\/([^/]+)\/Subtitles\/(\d+)\/Stream\.([^/]+)$/)
        : null;
    const playbackPing = method === "POST" && path === "/Sessions/Playing/Ping";
    const logout = method === "POST" && path === "/Sessions/Logout";
    const ping = (method === "GET" || method === "POST") && path === "/System/Ping";
    const serverDomains = method === "GET" && path === "/System/Ext/ServerDomains";
    const seasons = method === "GET" ? path.match(/^\/Shows\/([^/]+)\/Seasons$/) : null;
    const episodes = method === "GET" ? path.match(/^\/Shows\/([^/]+)\/Episodes$/) : null;
    const nextUp = method === "GET" && path === "/Shows/NextUp";
    const additionalParts =
      method === "GET" ? path.match(/^\/Videos\/([^/]+)\/AdditionalParts$/) : null;
    const hideFromResume =
      method === "POST" ? path.match(/^\/Users\/([^/]+)\/Items\/([^/]+)\/HideFromResume$/) : null;
    const watchlistItem = path.match(/^\/Users\/([^/]+)\/WatchlistItems\/([^/]+)$/);
    const watchlist = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Watchlist$/) : null;
    const historyClear =
      method === "POST" ? path.match(/^\/Users\/([^/]+)\/PlaybackHistory\/Clear$/) : null;
    const historyItem =
      method === "DELETE" ? path.match(/^\/Users\/([^/]+)\/PlaybackHistory\/([^/]+)$/) : null;
    const history =
      method === "GET" ? path.match(/^\/Users\/([^/]+)\/PlaybackHistory$/) : null;
    const playbackKind =
      method === "POST"
        ? path === "/Sessions/Playing"
          ? "start"
          : path === "/Sessions/Playing/Progress"
            ? "progress"
            : path === "/Sessions/Playing/Stopped"
              ? "stop"
              : null
        : null;

    if (
      !system &&
      !virtualFolders &&
      !displayPreferences &&
      !userProfile &&
      !views &&
      !userItems &&
      !latestItems &&
      !resumeItems &&
      !studios &&
      !allItems &&
      !userDetail &&
      !itemDetail &&
      !similar &&
      !userDataRoute &&
      !favorite &&
      !played &&
      !playbackInfo &&
      !videoStream &&
      !videoDownload &&
      !image &&
      !userImage &&
      !subtitle &&
      !playbackKind &&
      !playbackPing &&
      !logout &&
      !ping &&
      !serverDomains &&
      !itemCounts &&
      !genres &&
      !seasons &&
      !episodes &&
      !nextUp &&
      !additionalParts &&
      !hideFromResume &&
      !watchlistItem &&
      !watchlist &&
      !historyClear &&
      !historyItem &&
      !history
    )
      return notFound();

    const principal = yield* principalFor(services, request, url);
    const requestedUserId = url.searchParams.get("UserId") ?? url.searchParams.get("userId");
    if (requestedUserId !== null && requestedUserId !== principal.username) {
      return yield* Effect.fail(new EmbyForbidden());
    }
    if (system) return json(serverInfo(services));
    if (ping) return json("Emby Server");
    if (logout) {
      if (services.compat === undefined) return failure(500, "Internal", "Internal server error");
      yield* services.compat.deleteEmbyToken(principal.id);
      return json("");
    }
    if (playbackPing) return json({});
    if (serverDomains) {
      return json({
        ok: true,
        data: [{ name: services.config.serverName, url: new URL(request.url).origin }],
      });
    }
    if (itemCounts) {
      return json(
        services.compat === undefined
          ? { MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, ItemCount: 0 }
          : yield* services.compat.counts(),
      );
    }
    if (genres) {
      const bounds = pageBounds(url);
      if (bounds === null) return yield* Effect.fail(new InvalidEmbyRequest());
      const page =
        services.compat === undefined
          ? { names: [], total: 0 }
          : yield* services.compat.genres(bounds.start, bounds.limit);
      return json({
        Items: page.names.map((name) => ({ Id: `genre:${name}`, Name: name, ImageTags: {} })),
        TotalRecordCount: page.total,
        StartIndex: bounds.start,
      });
    }

    if (userProfile) return json(user(services, yield* requireUser(principal, userProfile[1]!)));

    if (displayPreferences) {
      const id = yield* pathSegment(displayPreferences[1]!);
      const userId = url.searchParams.get("userId");
      if (userId !== null && userId !== principal.username) {
        return yield* Effect.fail(new EmbyForbidden());
      }
      return json({
        Id: id,
        Client: url.searchParams.get("client") || "emby",
        RememberIndexing: false,
        PrimaryImageHeight: 250,
        PrimaryImageWidth: 250,
        CustomPrefs: {},
        ScrollDirection: "Horizontal",
        ShowBackdrop: true,
        RememberSorting: false,
        SortOrder: "Ascending",
        ShowSidebar: false,
      });
    }

    if (virtualFolders) {
      const libraries = yield* services.libraries.list();
      return json(
        libraries
          .filter(({ enabled }) => enabled)
          .map((library) => ({
            Name: library.name,
            Locations: [],
            CollectionType: library.mediaType === "series" ? "tvshows" : "movies",
            ItemId: library.id,
          })),
      );
    }

    if (views) {
      yield* requireUser(principal, views[1]!);
      const libraries = yield* services.libraries.list();
      const items = libraries
        .filter(({ enabled }) => enabled)
        .map((library) => ({
          Id: library.id,
          ServerId: services.config.serverId,
          Name: library.name,
          Type: "CollectionFolder",
          CollectionType: library.mediaType === "series" ? "tvshows" : "movies",
          IsFolder: true,
          UserData: userData(null, library.id),
        }));
      return json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
    }

    if (latestItems) {
      yield* requireUser(principal, latestItems[1]!);
      const decoded = yield* decodeItemsQuery(url);
      const input: FederatedQuery = {
        ...query(principal, decoded),
        sort: [{ field: "DateCreated", direction: "Descending" }],
        ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
      };
      const page = yield* services.federation.list(input);
      const flags = yield* loadFlags(
        services,
        page.items.map((item) => item.id),
      );
      const watched = decoded.IsWatchlisted;
      const items = page.items.filter(
        (item) =>
          watched === undefined || (flags.get(item.id)?.watchlisted ?? false) === watched,
      );
      return json(items.map((item) => paintItem(services, itemDto(item, services.config.serverId), flags)));
    }

    if (userItems || allItems || resumeItems || studios) {
      if (userItems) yield* requireUser(principal, userItems[1]!);
      if (resumeItems) yield* requireUser(principal, resumeItems[1]!);
      const decoded = yield* decodeItemsQuery(url);
      const base = query(principal, decoded);
      const input: FederatedQuery = {
        ...base,
        ...(resumeItems
          ? {
              filters: [...base.filters, { field: "resume", value: true }],
              sort:
                base.sort.length > 0
                  ? base.sort
                  : [{ field: "DatePlayed", direction: "Descending" }],
            }
          : {}),
        ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
      };
      const page = studios
        ? yield* services.federation.studios(input)
        : decoded.SearchTerm
          ? yield* services.federation.search({ ...input, searchTerm: decoded.SearchTerm })
          : yield* services.federation.list(input);
      const hidden = resumeItems && services.compat !== undefined ? yield* services.compat.hiddenIds() : new Set<string>();
      const visible = page.items.filter((item) => !hidden.has(item.id));
      const flags = studios
        ? new Map<string, ItemFlags>()
        : yield* loadFlags(
            services,
            visible.map((item) => item.id),
          );
      const watched = decoded.IsWatchlisted;
      const items = visible.filter(
        (item) => watched === undefined || (flags.get(item.id)?.watchlisted ?? false) === watched,
      );
      return json({
        Items: items.map((item) =>
          studios
            ? itemDto(item, services.config.serverId)
            : paintItem(services, itemDto(item, services.config.serverId), flags),
        ),
        TotalRecordCount: page.totalRecordCount - (page.items.length - items.length),
        StartIndex: input.startIndex,
      });
    }

    if (userDetail || itemDetail) {
      if (userDetail) yield* requireUser(principal, userDetail[1]!);
      const canonicalId = yield* pathSegment((userDetail?.[2] ?? itemDetail?.[1])!);
      const library = (yield* services.libraries.list()).find(
        ({ id, enabled }) => enabled && id === canonicalId,
      );
      if (library !== undefined)
        return json({
          Id: library.id,
          ServerId: services.config.serverId,
          Name: library.name,
          Type: "CollectionFolder",
          CollectionType: library.mediaType === "series" ? "tvshows" : "movies",
          IsFolder: true,
          UserData: userData(null, library.id),
        });
      const item = yield* services.federation.detail(canonicalId, clientUserAgent);
      if (item === null) return yield* Effect.fail(new EmbyNotFound());
      const flags = yield* loadFlags(services, [item.id]);
      return json(paintItem(services, itemDto(item, services.config.serverId), flags));
    }

    if (similar) {
      const canonicalId = yield* pathSegment(similar[1]!);
      if ((yield* services.federation.lookupMembership(canonicalId)) === null) {
        return yield* Effect.fail(new EmbyNotFound());
      }
      return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }

    if (userDataRoute) {
      yield* requireUser(principal, userDataRoute[1]!);
      const canonicalId = yield* pathSegment(userDataRoute[2]!);
      const body = yield* readJson(request).pipe(
        Effect.flatMap((value) => decode(EmbyUserDataPatch, value)),
      );
      const patch = yield* statePatch(body);
      const membership = yield* services.federation.lookupMembership(
        canonicalId,
        body.LastPlayedVersionId ?? undefined,
      );
      if (membership === null) return yield* Effect.fail(new EmbyNotFound());
      const written = yield* services.userState.write(membership.item.id, patch);
      const flags = yield* loadFlags(services, [membership.item.id]);
      return json(paintUserData(services, written, membership.item.id, flags));
    }

    if (favorite && (method === "POST" || method === "DELETE")) {
      yield* requireUser(principal, favorite[1]!);
      const canonicalId = yield* pathSegment(favorite[2]!);
      const membership = yield* services.federation.lookupMembership(canonicalId);
      if (membership === null) return yield* Effect.fail(new EmbyNotFound());
      const written = yield* services.userState.write(membership.item.id, {
        favorite: method === "POST",
      });
      const flags = yield* loadFlags(services, [membership.item.id]);
      return json(paintUserData(services, written, membership.item.id, flags));
    }

    if (played && (method === "POST" || method === "DELETE")) {
      yield* requireUser(principal, played[1]!);
      const canonicalId = yield* pathSegment(played[2]!);
      const membership = yield* services.federation.lookupMembership(canonicalId);
      if (membership === null) return yield* Effect.fail(new EmbyNotFound());
      const patch: UserStatePatch =
        method === "POST"
          ? { played: true, positionTicks: 0 }
          : { played: false, playCount: 0, positionTicks: 0 };
      const written = yield* services.userState.write(membership.item.id, patch);
      const flags = yield* loadFlags(services, [membership.item.id]);
      return json(paintUserData(services, written, membership.item.id, flags));
    }

    if (playbackInfo) {
      const canonicalId = yield* pathSegment(playbackInfo[1]!);
      const body =
        method === "POST"
          ? yield* readOptionalJson(request).pipe(
              Effect.flatMap((value) => decode(EmbyPlaybackRequest, value)),
            )
          : {};
      const queryUserId = url.searchParams.get("UserId");
      const querySource = url.searchParams.get("MediaSourceId");
      const queryAgent = url.searchParams.get("PlaybackUserAgent");
      if (
        !agree(queryUserId, body.UserId) ||
        !agree(querySource, body.MediaSourceId) ||
        !agree(queryAgent, body.PlaybackUserAgent)
      ) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const requestedId = body.UserId ?? queryUserId ?? undefined;
      if (requestedId !== undefined && requestedId !== "" && requestedId !== principal.username) {
        return yield* Effect.fail(new EmbyForbidden());
      }
      const mediaSourceId = (body.MediaSourceId ?? querySource)?.trim() || undefined;
      const playbackUserAgent = (body.PlaybackUserAgent ?? queryAgent)?.trim() || clientUserAgent;
      const membership = yield* services.federation.lookupMembership(canonicalId);
      if (membership === null) return yield* Effect.fail(new EmbyNotFound());
      const info = yield* services.playback.getInfo(membership.item.id, playbackUserAgent);
      const dto = playbackInfoDto(info);
      const sources = dto.MediaSources.flatMap((source) => {
        if (mediaSourceId !== undefined && source.Id !== mediaSourceId) return [];
        const current = source as EmbyMediaSourceDtoValue & { Path?: string; DirectStreamUrl?: string };
        if (typeof current.Path !== "string" || !current.Path.startsWith("/Videos/")) return [source];
        const absolute = new URL(current.Path, request.url).href;
        return [
          {
            ...current,
            Path: absolute,
            DirectStreamUrl: absolute,
            ...(playbackUserAgent === undefined
              ? {}
              : { RequiredHttpHeaders: { "User-Agent": playbackUserAgent } }),
          },
        ];
      });
      if (mediaSourceId !== undefined && sources.length === 0) {
        return yield* Effect.fail(new EmbyNotFound());
      }
      return json({ ...dto, MediaSources: sources });
    }

    if (videoStream || videoDownload) {
      if (services.playback.resolveVideoRedirect === undefined) return notFound();
      const canonicalId = yield* pathSegment((videoStream?.[1] ?? videoDownload?.[1])!);
      const mediaSourceId = url.searchParams.get("MediaSourceId")?.trim() || undefined;
      const location = yield* services.playback.resolveVideoRedirect({
        canonicalId,
        ...(mediaSourceId === undefined ? {} : { mediaSourceId }),
        ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
      });
      return redirect(location);
    }

    if (image) {
      if (services.playback.resolveImage === undefined) return notFound();
      const canonicalId = yield* pathSegment(image[1]!);
      const imageType = yield* pathSegment(image[2]!);
      const decision = yield* services.playback.resolveImage({
        canonicalId,
        imageType,
        ...(image[3] === undefined ? {} : { imageIndex: Number(image[3]) }),
        ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
      });
      if (decision._tag === "Redirect") {
        const response = redirect(decision.location);
        return method === "HEAD" ? withoutBody(response) : response;
      }
      const response = yield* serveRegisteredResource(decision.request, {
        ...(services.resourceCache === undefined ? {} : { cache: services.resourceCache }),
        now: services.now,
        signal: request.signal,
      });
      return method === "HEAD" ? withoutBody(response) : response;
    }

    if (subtitle) {
      if (services.playback.resolveSubtitle === undefined) return notFound();
      const decision = yield* services.playback.resolveSubtitle({
        canonicalId: yield* pathSegment(subtitle[1]!),
        mediaSourceId: yield* pathSegment(subtitle[2]!),
        streamIndex: Number(subtitle[3]),
        format: (yield* pathSegment(subtitle[4]!)).toLowerCase(),
        ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
      });
      if (decision._tag === "Redirect") return redirect(decision.location);
      return yield* serveRegisteredResource(decision.request, {
        now: services.now,
        signal: request.signal,
      });
    }

    if (userImage) {
      yield* requireUser(principal, userImage[1]!);
      const imageType = yield* pathSegment(userImage[2]!);
      const index = userImage[3] === undefined ? 0 : Number(userImage[3]);
      if (imageType !== "Primary" || index !== 0) return yield* Effect.fail(new EmbyNotFound());
      return new Response(method === "HEAD" ? null : defaultUserLogoBytes, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml",
          "content-length": String(defaultUserLogoBytes.byteLength),
          "cache-control": "private, no-store",
        },
      });
    }

    if (seasons || episodes) {
      const match = (seasons ?? episodes)!;
      const seriesId = yield* pathSegment(match[1]!);
      if (services.federation.showChildren === undefined) return notFound();
      const bounds = episodes ? pageBounds(url) : pageBounds(url, 200);
      if (bounds === null) return yield* Effect.fail(new InvalidEmbyRequest());
      const seasonRaw = episodes ? url.searchParams.get("Season") : null;
      const seasonNumber = seasonRaw === null ? undefined : Number(seasonRaw);
      if (
        seasonNumber !== undefined &&
        (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0)
      ) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const seasonId = episodes ? url.searchParams.get("SeasonId")?.trim() || undefined : undefined;
      const page = yield* services.federation.showChildren({
        seriesId,
        kind: seasons ? "Season" : "Episode",
        startIndex: bounds.start,
        limit: bounds.limit,
        ...(seasonNumber === undefined ? {} : { seasonNumber }),
        ...(seasonId === undefined ? {} : { seasonId }),
        ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
      });
      if (page === null) return yield* Effect.fail(new EmbyNotFound());
      const flags = yield* loadFlags(
        services,
        page.items.map((item) => item.id),
      );
      return json({
        Items: page.items.map((item) =>
          paintItem(services, itemDto(item, services.config.serverId), flags),
        ),
        TotalRecordCount: page.totalRecordCount,
        StartIndex: bounds.start,
      });
    }

    if (nextUp) {
      if (services.federation.showChildren === undefined) return notFound();
      const seriesId = url.searchParams.get("SeriesId")?.trim() || undefined;
      const seriesIds = seriesId
        ? [seriesId]
        : (yield* services.federation.list({
            userId: principal.username,
            deviceId: principal.deviceId,
            virtualLibraryId: null,
            startIndex: 0,
            limit: 50,
            sort: [],
            filters: [],
            itemTypes: ["Series"],
            ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
          })).items
            .filter((item) => item.itemType === "Series")
            .map((item) => item.id);
      const next: CanonicalItemView[] = [];
      for (const id of seriesIds) {
        const page = yield* services.federation.showChildren({
          seriesId: id,
          kind: "Episode",
          startIndex: 0,
          limit: 200,
          ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
        });
        if (page === null) {
          if (seriesId) return yield* Effect.fail(new EmbyNotFound());
          continue;
        }
        const regular = [...page.items]
          .filter((episode) => object(episode.displayMetadata).ParentIndexNumber !== 0)
          .sort((left, right) => {
            const leftSeason = Number(object(left.displayMetadata).ParentIndexNumber ?? 0);
            const rightSeason = Number(object(right.displayMetadata).ParentIndexNumber ?? 0);
            const leftIndex = Number(object(left.displayMetadata).IndexNumber ?? 0);
            const rightIndex = Number(object(right.displayMetadata).IndexNumber ?? 0);
            return leftSeason - rightSeason || leftIndex - rightIndex || left.id.localeCompare(right.id);
          });
        const upcoming = regular.find((episode) => !(episode.userState?.played ?? false));
        if (upcoming === undefined || (upcoming.userState?.positionTicks ?? 0) > 0) continue;
        next.push(upcoming);
      }
      const flags = yield* loadFlags(
        services,
        next.map((item) => item.id),
      );
      return json({
        Items: next.map((item) => paintItem(services, itemDto(item, services.config.serverId), flags)),
        TotalRecordCount: next.length,
        StartIndex: 0,
      });
    }

    if (additionalParts) {
      const canonicalId = yield* pathSegment(additionalParts[1]!);
      if ((yield* services.federation.lookupMembership(canonicalId)) === null) {
        return yield* Effect.fail(new EmbyNotFound());
      }
      return json([]);
    }

    if (hideFromResume) {
      if (services.compat === undefined) return failure(500, "Internal", "Internal server error");
      yield* requireUser(principal, hideFromResume[1]!);
      const canonicalId = yield* pathSegment(hideFromResume[2]!);
      const hideRaw = url.searchParams.get("Hide");
      const hide =
        hideRaw === null || hideRaw.trim() === ""
          ? true
          : hideRaw.toLowerCase() === "true"
            ? true
            : hideRaw.toLowerCase() === "false"
              ? false
              : null;
      if (hide === null) return yield* Effect.fail(new InvalidEmbyRequest());
      const membership = yield* services.federation.lookupMembership(canonicalId);
      if (membership === null) return yield* Effect.fail(new EmbyNotFound());
      yield* services.compat.setHiddenFromResume(membership.item.id, hide);
      const flags = yield* loadFlags(services, [membership.item.id]);
      return json(paintUserData(services, membership.item.userState, membership.item.id, flags));
    }

    if (watchlistItem && (method === "POST" || method === "DELETE")) {
      if (services.compat === undefined) return failure(500, "Internal", "Internal server error");
      yield* requireUser(principal, watchlistItem[1]!);
      const canonicalId = yield* pathSegment(watchlistItem[2]!);
      const membership = yield* services.federation.lookupMembership(canonicalId);
      if (membership === null) return yield* Effect.fail(new EmbyNotFound());
      yield* services.compat.setWatchlisted(
        membership.item.id,
        method === "POST",
        services.now(),
      );
      const flags = yield* loadFlags(services, [membership.item.id]);
      return json(paintUserData(services, membership.item.userState, membership.item.id, flags));
    }

    if (watchlist) {
      if (services.compat === undefined) return failure(500, "Internal", "Internal server error");
      yield* requireUser(principal, watchlist[1]!);
      const bounds = pageBounds(url);
      if (bounds === null) return yield* Effect.fail(new InvalidEmbyRequest());
      const saved = yield* services.compat.listWatchlist();
      const hydrated: CanonicalItemView[] = [];
      for (const entry of saved) {
        const item = yield* services.federation.detail(entry.canonicalId, clientUserAgent);
        if (item !== null) hydrated.push(item);
      }
      const term = url.searchParams.get("SearchTerm")?.trim().toLowerCase() ?? "";
      const types = split(url.searchParams.get("IncludeItemTypes"))?.filter(Boolean) ?? [];
      const filtered = hydrated.filter((item) => {
        const name = String(object(item.displayMetadata).Name ?? "").toLowerCase();
        return (term === "" || name.includes(term)) && (types.length === 0 || types.includes(item.itemType));
      });
      const page = filtered.slice(bounds.start, bounds.start + bounds.limit);
      const flags = yield* loadFlags(
        services,
        page.map((item) => item.id),
      );
      return json({
        Items: page.map((item) => paintItem(services, itemDto(item, services.config.serverId), flags)),
        TotalRecordCount: filtered.length,
        StartIndex: bounds.start,
      });
    }

    if (history || historyItem || historyClear) {
      if (services.compat === undefined) return failure(500, "Internal", "Internal server error");
      const match = (history ?? historyItem ?? historyClear)!;
      yield* requireUser(principal, match[1]!);
      if (historyClear) {
        const body = yield* readJson(request);
        const before = parseTimestamp(
          typeof body === "object" && body !== null && "Before" in body
            ? (body as { Before?: unknown }).Before
            : undefined,
        );
        if (before === null) return yield* Effect.fail(new InvalidEmbyRequest());
        return json({ ok: true, deleted: yield* services.compat.clearHistory(before) });
      }
      if (historyItem) {
        const removed = yield* services.compat.deleteHistory(yield* pathSegment(historyItem[2]!));
        if (!removed) return yield* Effect.fail(new EmbyNotFound());
        return json({ ok: true });
      }
      if (url.searchParams.has("Cursor") && url.searchParams.has("StartIndex")) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const bounds = pageBounds(url);
      if (bounds === null) return yield* Effect.fail(new InvalidEmbyRequest());
      const cursorRaw = url.searchParams.get("Cursor");
      const cursor = cursorRaw === null || cursorRaw === "" ? null : decodeHistoryCursor(cursorRaw);
      if (cursorRaw !== null && cursorRaw !== "" && cursor === null) {
        return yield* Effect.fail(new InvalidEmbyRequest());
      }
      const listed = yield* services.compat.listHistory({
        cursor,
        startIndex: bounds.start,
        limit: bounds.limit,
        search: url.searchParams.get("SearchTerm"),
        itemId: url.searchParams.get("ItemId"),
      });
      return json({
        Items: listed.items.map((entry) => ({
          Id: entry.id,
          ItemId: entry.canonicalId,
          Name: entry.itemName,
          MediaSourceId: entry.mediaSourceId,
          SourceName: entry.sourceName,
          Client: entry.clientName,
          DeviceName: entry.deviceName,
          StartedAt: isoTime(entry.startedAtMs),
          StoppedAt: entry.stoppedAtMs === null ? null : isoTime(entry.stoppedAtMs),
          PlaybackPositionTicks: entry.positionTicks,
          RunTimeTicks: entry.runtimeTicks,
          Completed: entry.completed,
          ...(percentage(entry.positionTicks, entry.runtimeTicks) === undefined
            ? {}
            : { PlayedPercentage: percentage(entry.positionTicks, entry.runtimeTicks) }),
        })),
        TotalRecordCount: listed.total,
        NextCursor: listed.nextCursor,
      });
    }

    if (playbackKind) {
      const body = yield* readJson(request).pipe(
        Effect.flatMap((value) => decode(EmbyPlaybackEvent, value)),
      );
      const membership = yield* services.federation.lookupMembership(
        body.ItemId,
        body.MediaSourceId,
      );
      if (membership === null || membership.version === null)
        return yield* Effect.fail(new EmbyNotFound());
      let completed = false;
      if (playbackKind === "stop") {
        const runtime = object(membership.item.displayMetadata).RunTimeTicks;
        completed =
          typeof runtime === "number" && runtime > 0 && (body.PositionTicks ?? 0) >= runtime;
      }
      yield* services.userState.recordPlaybackEvent(
        playbackEvent(
          playbackKind,
          body,
          membership.item.id,
          membership.version.id,
          services.now(),
          completed,
        ),
      );
      if (services.compat !== undefined) {
        const metadata = object(membership.item.displayMetadata);
        const runtime = metadata.RunTimeTicks;
        const authorization = {
          ...parseAuthorization(request.headers.get("authorization")),
          ...parseAuthorization(request.headers.get("x-emby-authorization")),
        };
        yield* services.compat.recordPlayback({
          kind: playbackKind,
          playSessionId: body.PlaySessionId,
          canonicalId: membership.item.id,
          itemName: typeof metadata.Name === "string" ? metadata.Name : membership.item.id,
          mediaSourceId: body.MediaSourceId,
          sourceName: membership.version.label,
          deviceName: principal.deviceName,
          clientName: authorization.client ?? null,
          positionTicks: body.PositionTicks ?? 0,
          runtimeTicks: typeof runtime === "number" ? runtime : null,
          completed,
          nowMs: services.now(),
        });
      }
      return new Response(null, { status: 204 });
    }

    return notFound();
  });

export const makeEmbyHandler =
  (services: EmbyServices) =>
  (request: Request): Effect.Effect<Response> => {
    const startedAt = Date.now();
    return handle(services, request).pipe(
      Effect.tap((response) => Effect.sync(() => logRequest(request, response, startedAt))),
      Effect.catch((error) =>
        Effect.sync(() => {
          const response = publicFailure(error);
          logRequest(request, response, startedAt, error);
          return response;
        }),
      ),
      Effect.raceFirst(interruptWhenAborted(request.signal)),
    );
  };
