import type { SourceLibraryView } from "@oh-my-emby/contracts";
import { Context, Effect, Layer, Schema, type Scope } from "effect";

import {
  DestinationRejected,
  HttpsDowngrade,
  InvalidUpstreamUrl,
  ObsoleteGeneration,
  RedirectLimitExceeded,
  RedirectLoop,
  ResponseTooLarge,
  ServerNotFound,
  UpstreamInvalidResponse,
  UpstreamNotFound,
  UpstreamRejected,
  UpstreamTimeout,
  UpstreamUnavailable,
  type UpstreamFailure,
} from "./errors.js";
import {
  MAX_CONNECTION_DIAGNOSTIC_BYTES,
  MAX_CONTROL_RESPONSE_BYTES,
  MAX_IMAGE_BYTES,
  UPSTREAM_DETAIL_DEADLINE_MS,
  UPSTREAM_LIST_DEADLINE_MS,
} from "./limits.js";
import type { SourceMediaVersion, UpstreamEndpoint, UpstreamServer } from "./model.js";
import { makeObservability, type ObservabilityService } from "./observability.js";
import { Repositories } from "./repositories.js";

const MAX_REDIRECTS = 3;
const redirects = new Set([301, 302, 303, 307, 308]);
const failoverStatuses = new Set([500, 502, 503, 504]);
const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

export interface DestinationPolicy {
  readonly platform: "workers" | "docker";
}

export interface UpstreamRequest {
  readonly serverId: string;
  readonly generation: number;
  readonly path: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly body?: Uint8Array;
  readonly replaySafe?: boolean;
  readonly replayPath?: (upstreamUserId: string) => string;
  readonly resourcePolicy?: "control" | "registered-resource";
  readonly clientUserAgent?: string;
}

export interface AuthenticatedServer {
  readonly server: UpstreamServer;
  readonly catalogId: string | null;
  readonly upstreamUserId: string;
}

export type SourceLibrary = SourceLibraryView;

export interface ResolvedPlayback {
  readonly serverId: string;
  readonly generation: number;
  readonly url: string;
  readonly clientUserAgent?: string;
}

export interface RegisteredUpstreamResourceRequest {
  readonly serverId: string;
  readonly generation: number;
  readonly url: URL;
  readonly accept: ReadonlyArray<string>;
  readonly clientUserAgent?: string;
}

export interface RegisteredResourceFetchContext {
  readonly server: UpstreamServer;
  readonly destinationPolicy: DestinationPolicy;
  readonly isConnectedAddressAllowed: (address: string) => boolean;
}

export interface UpstreamClientService {
  readonly request: <A>(
    request: UpstreamRequest,
    schema: Schema.Schema<A>,
  ) => Effect.Effect<A, UpstreamFailure>;
  readonly requestImage: (
    input: UpstreamRequest,
  ) => Effect.Effect<{ bytes: Uint8Array; contentType: string }, UpstreamFailure>;
  readonly authenticate: (
    server: UpstreamServer,
    includeDiagnostic?: boolean,
    endpointId?: string,
    clientUserAgent?: string,
  ) => Effect.Effect<AuthenticatedServer, UpstreamFailure>;
  readonly getServerIdentity: (
    serverId: string,
    includeDiagnostic?: boolean,
    endpointId?: string,
  ) => Effect.Effect<string | null, UpstreamFailure>;
  readonly probeServerIdentity: (
    server: UpstreamServer,
    endpoint: UpstreamEndpoint,
    includeDiagnostic?: boolean,
  ) => Effect.Effect<string | null, UpstreamFailure>;
  readonly probeServerName: (
    server: UpstreamServer,
    endpoint: UpstreamEndpoint,
  ) => Effect.Effect<string | null, UpstreamFailure>;
  readonly listSourceLibraries: (
    serverId: string,
  ) => Effect.Effect<ReadonlyArray<SourceLibrary>, UpstreamFailure>;
  readonly resolvePlayback: (
    version: SourceMediaVersion,
  ) => Effect.Effect<ResolvedPlayback, UpstreamFailure>;
  readonly resolvePlaybackRedirect: (
    playback: ResolvedPlayback,
  ) => Effect.Effect<URL, UpstreamFailure>;
  readonly requestResource: (
    request: RegisteredUpstreamResourceRequest,
  ) => Effect.Effect<Response, UpstreamFailure, Scope.Scope>;
}

export class UpstreamClient extends Context.Service<UpstreamClient, UpstreamClientService>()(
  "oh-my-emby/UpstreamClient",
) {}

export interface UpstreamClientConfig {
  readonly fetch: typeof globalThis.fetch;
  /** Platform transport that pins or validates the actual connected destination before sending. */
  readonly fetchRegisteredResource?: (
    request: Request,
    context: RegisteredResourceFetchContext,
  ) => Promise<Response>;
  readonly destinationPolicy: DestinationPolicy;
  readonly observability?: ObservabilityService;
  readonly timeoutMs?: number;
}

const normalizedBaseUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidUpstreamUrl();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new InvalidUpstreamUrl();
  return url;
};

export const normalizeUpstreamBaseUrl = (value: string): string => {
  const url = normalizedBaseUrl(value);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href.replace(/\/$/, "");
};

const resolveApiUrl = (base: URL, path: string): URL => {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new InvalidUpstreamUrl();
  }
  const directory = new URL(base);
  directory.pathname = `${directory.pathname.replace(/\/+$/, "")}/`;
  const url = new URL(path.replace(/^\//, ""), directory);
  const basePath = base.pathname.replace(/\/+$/, "");
  const prefix = basePath === "" ? "/" : `${basePath}/`;
  if (
    url.origin !== base.origin ||
    (url.pathname !== basePath && !url.pathname.startsWith(prefix))
  ) {
    throw new InvalidUpstreamUrl();
  }
  return url;
};

export const endpointUrl = (
  endpoint: Pick<UpstreamEndpoint, "protocol" | "host" | "port" | "path">,
  path?: string,
): URL => {
  const base = normalizedBaseUrl(
    `${endpoint.protocol}://${endpoint.host}${endpoint.port === null ? "" : `:${endpoint.port}`}${endpoint.path}`,
  );
  return path === undefined ? base : resolveApiUrl(base, path);
};

const PRODUCT_USER_AGENT = "oh-my-emby/0.0.0";

export const effectiveUserAgent = (
  server: Pick<UpstreamServer, "userAgentPolicy" | "userAgent">,
  clientUserAgent?: string,
): string => {
  const inbound = clientUserAgent?.trim() || undefined;
  switch (server.userAgentPolicy) {
    case "fixed":
      return server.userAgent ?? PRODUCT_USER_AGENT;
    case "client-preferred":
      return inbound ?? server.userAgent ?? PRODUCT_USER_AGENT;
    case "passthrough":
      return inbound ?? PRODUCT_USER_AGENT;
  }
};

const normalizeIpLiteral = (hostname: string): string | null => {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare.includes(":")) {
    try {
      const parsed = new URL(`http://[${bare}]/`).hostname;
      return parsed.slice(1, -1).toLowerCase();
    } catch {
      return null;
    }
  }
  const parts = bare.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return null;
  }
  return parts.map(Number).join(".");
};

const isIpLiteral = (hostname: string): boolean => normalizeIpLiteral(hostname) !== null;

const isPrivateIpLiteral = (hostname: string): boolean => {
  const address = normalizeIpLiteral(hostname);
  if (address === null) return false;
  if (!address.includes(":")) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (address === "::" || address === "::1") return true;
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return isPrivateIpLiteral(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const first = Number.parseInt(address.split(":", 1)[0]!, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
};

const isPrivateHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    return true;
  }
  return isPrivateIpLiteral(lower);
};

const connectedAddressAllowed = (policy: DestinationPolicy): ((address: string) => boolean) => {
  return (address) => {
    const normalized = normalizeIpLiteral(address);
    if (normalized === null) return false;
    return policy.platform === "docker" || !isPrivateIpLiteral(normalized);
  };
};

const validateDestination = (
  url: URL,
  server: UpstreamServer,
  endpoint: UpstreamEndpoint | undefined,
  policy: DestinationPolicy,
  resourcePolicy: UpstreamRequest["resourcePolicy"] = "control",
): Effect.Effect<void, DestinationRejected> => {
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Effect.fail(new DestinationRejected({ serverId: server.id }));
  }
  if (url.username !== "" || url.password !== "") {
    return Effect.fail(new DestinationRejected({ serverId: server.id }));
  }
  const configuredBase = endpoint === undefined ? undefined : endpointUrl(endpoint);
  if (
    resourcePolicy === "control" &&
    configuredBase !== undefined &&
    url.origin !== configuredBase.origin
  ) {
    return Effect.fail(new DestinationRejected({ serverId: server.id }));
  }
  if (policy.platform === "workers") {
    if (isIpLiteral(hostname) || isPrivateHostname(hostname)) {
      return Effect.fail(new DestinationRejected({ serverId: server.id }));
    }
  }
  return Effect.void;
};

const sensitiveDiagnosticValue =
  /(["']?(?:access[_-]?token|token|password|pw|(?:x[_-])?api[_-]?key|client[_-]?secret|authorization|(?:set[_-])?cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}&]+)/gi;

const redactDiagnostic = (value: string): string =>
  value
    .replace(sensitiveDiagnosticValue, (match, prefix: string) => {
      const rawValue = match.slice(prefix.length);
      const quote = rawValue[0];
      return quote === '"' || quote === "'"
        ? `${prefix}${quote}[redacted]${quote}`
        : `${prefix}[redacted]`;
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]");

const limitDiagnostic = (value: string): string => {
  const bytes = utf8Encoder.encode(value);
  if (bytes.byteLength <= MAX_CONNECTION_DIAGNOSTIC_BYTES) return value;
  const suffix = "\n…";
  let end = MAX_CONNECTION_DIAGNOSTIC_BYTES - utf8Encoder.encode(suffix).byteLength;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${utf8.decode(bytes.slice(0, end))}${suffix}`;
};

const transportDiagnostic = (error: unknown): string | undefined => {
  let message: string | undefined;
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  return message === undefined || message === ""
    ? undefined
    : limitDiagnostic(redactDiagnostic(message));
};

const responseDiagnostic = (value: string | undefined, response: Response): string | undefined => {
  if (response.status === 497) return "The plain HTTP request was sent to HTTPS port.";
  if (value === undefined) return undefined;
  const isHtml =
    /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") ?? "") ||
    /<!doctype\s+html|<\/?(?:html|head|body|script|style)\b/i.test(value);
  let text = value;
  if (isHtml) {
    const entities: Record<string, string> = {
      amp: "&",
      quot: '"',
      apos: "'",
      lt: "<",
      gt: ">",
      nbsp: " ",
    };
    text = text
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<[^>]*(?:>|$)/g, " ")
      .replace(
        /&(amp|quot|apos|lt|gt|nbsp);/gi,
        (match, entity: string) => entities[entity.toLowerCase()] ?? match,
      );
  }
  text = redactDiagnostic(text);
  if (isHtml) text = text.replace(/\s+/g, " ").trim();
  return text === "" ? undefined : limitDiagnostic(text);
};

const readBoundedText = (
  response: Response,
  serverId: string,
  maxBytes: number,
  truncate = false,
): Effect.Effect<string | undefined, ResponseTooLarge | UpstreamUnavailable> =>
  Effect.gen(function* () {
    const declared = response.headers.get("content-length");
    if (!truncate && declared !== null && Number(declared) > maxBytes) {
      return yield* Effect.fail(new ResponseTooLarge({ serverId }));
    }
    if (response.body === null) return undefined;
    const reader = response.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    let truncated = false;
    while (true) {
      const result = yield* Effect.tryPromise({
        try: (signal) => {
          const cancel = () => {
            void reader.cancel();
          };
          signal.addEventListener("abort", cancel, { once: true });
          return reader.read().finally(() => signal.removeEventListener("abort", cancel));
        },
        catch: () => new UpstreamUnavailable({ serverId }),
      });
      if (result.done) break;
      const remaining = maxBytes - size;
      if (result.value.byteLength > remaining) {
        if (!truncate) {
          yield* Effect.promise(() => reader.cancel()).pipe(Effect.ignore);
          return yield* Effect.fail(new ResponseTooLarge({ serverId }));
        }
        if (remaining > 0) chunks.push(result.value.slice(0, remaining));
        size = maxBytes;
        truncated = true;
        yield* Effect.promise(() => reader.cancel()).pipe(Effect.ignore);
        break;
      }
      size += result.value.byteLength;
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (size === 0) return undefined;
    return `${utf8.decode(bytes)}${truncated ? "\n…" : ""}`;
  });

const classifyStatus = (
  serverId: string,
  response: Response,
  includeDiagnostic = false,
): Effect.Effect<void, UpstreamFailure> => {
  if (response.ok) return Effect.void;
  if (!includeDiagnostic) {
    return Effect.fail(
      response.status === 404
        ? new UpstreamNotFound({ serverId })
        : new UpstreamRejected({ serverId, status: response.status }),
    );
  }
  return Effect.gen(function* () {
    const detail = yield* readBoundedText(
      response,
      serverId,
      MAX_CONNECTION_DIAGNOSTIC_BYTES,
      true,
    ).pipe(
      Effect.map((value) => responseDiagnostic(value, response)),
      Effect.orElseSucceed(() => undefined),
    );
    const diagnostic = detail === undefined ? {} : { detail };
    return yield* Effect.fail(
      response.status === 404
        ? new UpstreamNotFound({ serverId, ...diagnostic })
        : new UpstreamRejected({ serverId, status: response.status, ...diagnostic }),
    );
  });
};

const readBoundedJson = (
  response: Response,
  serverId: string,
): Effect.Effect<unknown, ResponseTooLarge | UpstreamInvalidResponse | UpstreamUnavailable> =>
  readBoundedText(response, serverId, MAX_CONTROL_RESPONSE_BYTES).pipe(
    Effect.flatMap((text) => {
      if (text === undefined) return Effect.succeed(undefined);
      return Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new UpstreamInvalidResponse({ serverId }),
      });
    }),
  );

const AuthenticationResponse = Schema.Struct({
  AccessToken: Schema.String,
  ServerId: Schema.optional(Schema.String),
  User: Schema.Struct({ Id: Schema.String }),
});

const PublicSystemInfo = Schema.Struct({
  Id: Schema.optional(Schema.String),
});

const PublicServerName = Schema.Struct({
  ServerName: Schema.optional(Schema.NullOr(Schema.String)),
});

const VirtualFolders = Schema.Array(
  Schema.Struct({
    ItemId: Schema.String,
    Name: Schema.String,
    CollectionType: Schema.optional(Schema.String),
  }),
);

const UserViews = Schema.Struct({
  Items: Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Name: Schema.String,
      CollectionType: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const ContentTypeProbe = Schema.Struct({
  Items: Schema.Array(Schema.Struct({ Type: Schema.String })),
});

const collectionMediaType = (
  collectionType: string | null | undefined,
): SourceLibrary["mediaType"] | null => {
  if (collectionType === "movies") return "movies";
  if (collectionType === "tvshows" || collectionType === "series") return "series";
  return null;
};

export const makeUpstreamClientLayer = (
  config: UpstreamClientConfig,
): Layer.Layer<UpstreamClient, never, Repositories> =>
  Layer.effect(
    UpstreamClient,
    Effect.gen(function* () {
      const repositories = yield* Repositories;
      const timeoutMs = config.timeoutMs ?? UPSTREAM_DETAIL_DEADLINE_MS;
      const observability = config.observability ?? makeObservability();

      const deadline = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        serverId: string,
        durationMs = timeoutMs,
      ): Effect.Effect<A, E | UpstreamTimeout, R> =>
        effect.pipe(
          Effect.timeout(durationMs),
          Effect.catchTag("TimeoutError", () => Effect.fail(new UpstreamTimeout({ serverId }))),
        );

      const getServer = (
        serverId: string,
      ): Effect.Effect<UpstreamServer, ServerNotFound | import("./errors.js").RepositoryError> =>
        repositories
          .getServer(serverId)
          .pipe(
            Effect.flatMap((server) =>
              server === null
                ? Effect.fail(new ServerNotFound({ serverId }))
                : Effect.succeed(server),
            ),
          );

      const fetchOnce = (
        server: UpstreamServer,
        url: URL,
        init: RequestInit,
        includeDiagnostic = false,
      ): Effect.Effect<Response, UpstreamUnavailable | UpstreamTimeout> =>
        Effect.tryPromise({
          try: (signal) => config.fetch(new Request(url, { ...init, signal }), { signal }),
          catch: (error) => {
            const detail = includeDiagnostic ? transportDiagnostic(error) : undefined;
            return new UpstreamUnavailable({
              serverId: server.id,
              ...(detail === undefined ? {} : { detail }),
            });
          },
        }).pipe(
          Effect.timeout(timeoutMs),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(new UpstreamTimeout({ serverId: server.id })),
          ),
        );

      const embyAuthorization = (server: UpstreamServer): string =>
        `MediaBrowser Client="oh-my-emby", Device="oh-my-emby", DeviceId="${server.id}", Version="0.0.0"`;

      const fetchWithRedirects = (
        server: UpstreamServer,
        endpoint: UpstreamEndpoint,
        request: UpstreamRequest,
        token: string | null,
        includeDiagnostic = false,
      ): Effect.Effect<Response, UpstreamFailure> =>
        Effect.gen(function* () {
          const url = yield* Effect.try({
            try: () => endpointUrl(endpoint, request.path),
            catch: (error) =>
              error instanceof InvalidUpstreamUrl ? error : new InvalidUpstreamUrl(),
          });
          yield* validateDestination(
            url,
            server,
            endpoint,
            config.destinationPolicy,
            request.resourcePolicy,
          );

          let current = url;
          let method: UpstreamRequest["method"] = request.method;
          let body = request.body;
          let headers = new Headers({
            accept: "application/json",
            "user-agent": effectiveUserAgent(server, request.clientUserAgent),
            "x-emby-authorization": embyAuthorization(server),
          });
          if (body !== undefined) headers.set("content-type", "application/json");
          if (token !== null) headers.set("x-emby-token", token);
          const visited = new Set([current.href]);

          for (let redirectCount = 0; ; redirectCount++) {
            const init: RequestInit =
              body === undefined
                ? { method, headers, redirect: "manual" }
                : { method, headers, body: Uint8Array.from(body).buffer, redirect: "manual" };
            const response = yield* fetchOnce(server, current, init, includeDiagnostic);
            if (!redirects.has(response.status)) return response;
            if (redirectCount >= MAX_REDIRECTS) {
              return yield* Effect.fail(new RedirectLimitExceeded({ serverId: server.id }));
            }
            const location = response.headers.get("location");
            if (location === null)
              return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: server.id }));
            const next = yield* Effect.try({
              try: () => new URL(location, current),
              catch: () => new InvalidUpstreamUrl(),
            });
            if (current.protocol === "https:" && next.protocol === "http:") {
              return yield* Effect.fail(new HttpsDowngrade({ serverId: server.id }));
            }
            yield* validateDestination(
              next,
              server,
              endpoint,
              config.destinationPolicy,
              request.resourcePolicy,
            );
            if (visited.has(next.href))
              return yield* Effect.fail(new RedirectLoop({ serverId: server.id }));
            visited.add(next.href);
            if (next.origin !== current.origin) {
              if (method !== "GET")
                return yield* Effect.fail(new DestinationRejected({ serverId: server.id }));
              headers = new Headers({
                accept: "application/json",
                "user-agent": effectiveUserAgent(server, request.clientUserAgent),
              });
              body = undefined;
            } else if (
              response.status === 303 ||
              ((response.status === 301 || response.status === 302) && method === "POST")
            ) {
              method = "GET";
              body = undefined;
              headers.delete("content-type");
            }
            current = next;
          }
        });

      const decodeResponse = <A>(
        response: Response,
        serverId: string,
        schema: Schema.Schema<A>,
        includeDiagnostic = false,
      ): Effect.Effect<A, UpstreamFailure> =>
        Effect.gen(function* () {
          yield* classifyStatus(serverId, response, includeDiagnostic);
          const value = yield* readBoundedJson(response, serverId);
          const decode = Schema.decodeUnknownEffect(schema) as (
            input: unknown,
          ) => Effect.Effect<A, unknown, never>;
          return yield* decode(value).pipe(
            Effect.mapError(() => new UpstreamInvalidResponse({ serverId })),
          );
        });

      const eligibleEndpoints = (server: UpstreamServer): ReadonlyArray<UpstreamEndpoint> =>
        server.endpoints.filter(
          (endpoint) =>
            endpoint.health === "healthy" &&
            (server.verifiedCatalogId === null
              ? endpoint.verifiedCatalogId === null
              : endpoint.verifiedCatalogId === server.verifiedCatalogId),
        );

      const endpointForUrl = (server: UpstreamServer, url: URL): UpstreamEndpoint | undefined =>
        eligibleEndpoints(server)
          .map((endpoint) => {
            const base = endpointUrl(endpoint);
            const basePath = base.pathname.replace(/\/+$/, "");
            return { endpoint, base, basePath };
          })
          .filter(({ base, basePath }) => {
            const prefix = basePath === "" ? "/" : `${basePath}/`;
            return (
              url.origin === base.origin &&
              (url.pathname === basePath || url.pathname.startsWith(prefix))
            );
          })
          .sort((left, right) => right.basePath.length - left.basePath.length)[0]?.endpoint;

      const endpointAttemptsForUrl = (
        server: UpstreamServer,
        url: URL,
      ): ReadonlyArray<{ readonly endpoint: UpstreamEndpoint; readonly url: URL }> => {
        const endpoints = eligibleEndpoints(server);
        const initial = endpointForUrl(server, url);
        if (initial === undefined) return [];
        const initialBasePath = endpointUrl(initial).pathname.replace(/\/+$/, "");
        const relativePath = url.pathname.slice(initialBasePath.length);
        return endpoints.slice(endpoints.indexOf(initial)).map((endpoint) => {
          const next = endpointUrl(endpoint);
          const basePath = next.pathname.replace(/\/+$/, "");
          next.pathname = `${basePath}${relativePath}` || "/";
          next.search = url.search;
          return { endpoint, url: next };
        });
      };

      const endpointById = (
        server: UpstreamServer,
        endpointId: string,
      ): Effect.Effect<UpstreamEndpoint, UpstreamUnavailable> => {
        const endpoint = server.endpoints.find(({ id }) => id === endpointId);
        return endpoint === undefined
          ? Effect.fail(new UpstreamUnavailable({ serverId: server.id }))
          : Effect.succeed(endpoint);
      };

      const endpointFailure = (failure: UpstreamFailure): boolean =>
        failure._tag === "UpstreamUnavailable" ||
        failure._tag === "UpstreamTimeout" ||
        (failure._tag === "UpstreamRejected" && failoverStatuses.has(failure.status));

      const authenticateServer = (
        server: UpstreamServer,
        includeDiagnostic = false,
        endpointId?: string,
        clientUserAgent?: string,
        persist = true,
      ) =>
        deadline(
          Effect.gen(function* () {
            if (server.password === null)
              return yield* Effect.fail(new UpstreamRejected({ serverId: server.id, status: 401 }));
            const endpoint =
              endpointId === undefined
                ? server.endpoints[0]
                : yield* endpointById(server, endpointId);
            if (endpoint === undefined)
              return yield* Effect.fail(new UpstreamUnavailable({ serverId: server.id }));
            const body = new TextEncoder().encode(
              JSON.stringify({ Username: server.username, Pw: server.password }),
            );
            const response = yield* fetchWithRedirects(
              server,
              endpoint,
              {
                serverId: server.id,
                generation: server.generation,
                path: "/Users/AuthenticateByName",
                method: "POST",
                body,
                ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
              },
              null,
              includeDiagnostic,
            );
            const authenticated = yield* decodeResponse(
              response,
              server.id,
              AuthenticationResponse,
              includeDiagnostic,
            );
            const saved = persist
              ? yield* repositories.saveServerResult({
                  serverId: server.id,
                  expectedGeneration: server.generation,
                  accessToken: authenticated.AccessToken,
                  accessTokenExpiresAtMs: null,
                  upstreamUserId: authenticated.User.Id,
                  updatedAtMs: Date.now(),
                })
              : {
                  ...server,
                  accessToken: authenticated.AccessToken,
                  upstreamUserId: authenticated.User.Id,
                };
            if (saved === null)
              return yield* Effect.fail(new ObsoleteGeneration({ serverId: server.id }));
            return {
              server: saved,
              catalogId: authenticated.ServerId?.trim() || null,
              upstreamUserId: authenticated.User.Id,
            };
          }),
          server.id,
        );

      const authenticate: UpstreamClientService["authenticate"] = (
        server,
        includeDiagnostic = false,
        endpointId,
        clientUserAgent,
      ) => authenticateServer(server, includeDiagnostic, endpointId, clientUserAgent);

      const requestWithDecoder = <A>(
        input: UpstreamRequest,
        decode: (response: Response, serverId: string) => Effect.Effect<A, UpstreamFailure>,
      ) => {
        const requestId = crypto.randomUUID();
        const startedAtMs = Date.now();
        const trace = { retried: false };
        const route =
          /^[a-z][a-z\d+.-]*:/i.test(input.path) || input.path.startsWith("//")
            ? "<invalid>"
            : input.path.split(/[?#]/, 1)[0] || "/";
        const operation = getServer(input.serverId).pipe(
          Effect.flatMap((server) => {
            const endpoints = eligibleEndpoints(server);
            const durationMs =
              config.timeoutMs ??
              (input.path === "/Library/VirtualFolders"
                ? UPSTREAM_LIST_DEADLINE_MS
                : UPSTREAM_DETAIL_DEADLINE_MS);
            return deadline(
              Effect.gen(function* () {
                if (server.generation !== input.generation) {
                  return yield* Effect.fail(new ObsoleteGeneration({ serverId: input.serverId }));
                }
                if (endpoints.length === 0) {
                  return yield* Effect.fail(new UpstreamUnavailable({ serverId: input.serverId }));
                }
                let activeServer = server;
                let activeRequest = input;
                for (let index = 0; index < endpoints.length; index++) {
                  const endpoint = endpoints[index]!;
                  const fetched = yield* fetchWithRedirects(
                    activeServer,
                    endpoint,
                    activeRequest,
                    activeServer.accessToken,
                  ).pipe(Effect.result);
                  if (fetched._tag === "Failure") {
                    if (
                      input.method === "GET" &&
                      index + 1 < endpoints.length &&
                      (fetched.failure._tag === "UpstreamUnavailable" ||
                        fetched.failure._tag === "UpstreamTimeout")
                    ) {
                      trace.retried = true;
                      continue;
                    }
                    return yield* Effect.fail(fetched.failure);
                  }
                  let response = fetched.success;
                  if (
                    input.method === "GET" &&
                    index + 1 < endpoints.length &&
                    failoverStatuses.has(response.status)
                  ) {
                    trace.retried = true;
                    void response.body?.cancel().catch(() => undefined);
                    continue;
                  }
                  if (
                    response.status === 401 &&
                    (input.method === "GET" || input.replaySafe === true) &&
                    server.password !== null
                  ) {
                    trace.retried = true;
                    const authentication = yield* authenticate(
                      activeServer,
                      false,
                      endpoint.id,
                      input.clientUserAgent,
                    ).pipe(Effect.result);
                    if (authentication._tag === "Failure") {
                      if (
                        input.method === "GET" &&
                        index + 1 < endpoints.length &&
                        endpointFailure(authentication.failure)
                      ) {
                        continue;
                      }
                      return yield* Effect.fail(authentication.failure);
                    }
                    const refreshed = authentication.success;
                    activeServer = refreshed.server;
                    const refreshedEndpoint = yield* endpointById(refreshed.server, endpoint.id);
                    if (input.replayPath !== undefined) {
                      activeRequest = {
                        ...input,
                        path: input.replayPath(refreshed.upstreamUserId),
                      };
                    }
                    const replayed = yield* fetchWithRedirects(
                      refreshed.server,
                      refreshedEndpoint,
                      activeRequest,
                      refreshed.server.accessToken,
                    ).pipe(Effect.result);
                    if (replayed._tag === "Failure") {
                      if (
                        input.method === "GET" &&
                        index + 1 < endpoints.length &&
                        endpointFailure(replayed.failure)
                      ) {
                        continue;
                      }
                      return yield* Effect.fail(replayed.failure);
                    }
                    response = replayed.success;
                    if (
                      input.method === "GET" &&
                      index + 1 < endpoints.length &&
                      failoverStatuses.has(response.status)
                    ) {
                      void response.body?.cancel().catch(() => undefined);
                      continue;
                    }
                  }
                  const decoded = yield* decode(response, input.serverId);
                  const current = yield* getServer(input.serverId);
                  if (current.generation !== input.generation) {
                    return yield* Effect.fail(new ObsoleteGeneration({ serverId: input.serverId }));
                  }
                  return decoded;
                }
                return yield* Effect.fail(new UpstreamUnavailable({ serverId: input.serverId }));
              }),
              input.serverId,
              durationMs * Math.max(1, endpoints.length),
            );
          }),
        );
        const record = (failureCategory: string) => {
          let retryOutcome: "none" | "retried" | "failed" = "none";
          if (trace.retried) retryOutcome = failureCategory === "none" ? "retried" : "failed";
          return observability.upstreamRequest({
            requestId,
            route,
            serverId: input.serverId,
            durationMs: Date.now() - startedAtMs,
            cacheOutcome: "bypass",
            retryOutcome,
            failureCategory,
          });
        };
        return operation.pipe(
          Effect.tap(() => record("none")),
          Effect.tapError((error) => record(error._tag)),
        );
      };

      const request: UpstreamClientService["request"] = (input, schema) =>
        requestWithDecoder(input, (response, serverId) =>
          decodeResponse(response, serverId, schema),
        );
      const requestImage: UpstreamClientService["requestImage"] = (input) =>
        requestWithDecoder(input, (response, serverId) =>
          Effect.gen(function* () {
            yield* classifyStatus(serverId, response);
            const contentType =
              response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
            if (
              !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
              !response.body
            ) {
              void response.body?.cancel();
              return yield* Effect.fail(new UpstreamInvalidResponse({ serverId }));
            }
            const advertised = response.headers.get("content-length");
            if (
              advertised !== null &&
              (!/^\d+$/.test(advertised) || Number(advertised) > MAX_IMAGE_BYTES)
            ) {
              void response.body.cancel();
              return yield* Effect.fail(new ResponseTooLarge({ serverId }));
            }
            const reader = response.body.getReader(),
              chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const part = yield* Effect.tryPromise({
                  try: (signal) => {
                    const abort = () => {
                      void reader.cancel();
                    };
                    signal.addEventListener("abort", abort, { once: true });
                    return reader.read().finally(() => signal.removeEventListener("abort", abort));
                  },
                  catch: () => new UpstreamUnavailable({ serverId }),
                });
                if (part.done) break;
                size += part.value.length;
                if (size > MAX_IMAGE_BYTES)
                  return yield* Effect.fail(new ResponseTooLarge({ serverId }));
                chunks.push(part.value);
              }
            } finally {
              void reader.cancel().catch(() => undefined);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            return { bytes, contentType };
          }),
        );

      const serverIdentity = (
        server: UpstreamServer,
        endpoint: UpstreamEndpoint,
        includeDiagnostic: boolean,
        persistAuthentication: boolean,
      ) =>
        deadline(
          Effect.gen(function* () {
            const authenticated = yield* authenticateServer(
              server,
              includeDiagnostic,
              endpoint.id,
              undefined,
              persistAuthentication,
            );
            if (authenticated.catalogId !== null) return authenticated.catalogId;
            const refreshedEndpoint = yield* endpointById(authenticated.server, endpoint.id);
            const response = yield* fetchWithRedirects(
              authenticated.server,
              refreshedEndpoint,
              {
                serverId: server.id,
                generation: server.generation,
                path: "/System/Info/Public",
                method: "GET",
              },
              null,
              includeDiagnostic,
            );
            const info = yield* decodeResponse(
              response,
              server.id,
              PublicSystemInfo,
              includeDiagnostic,
            );
            return info.Id?.trim() || null;
          }),
          server.id,
        );

      const getServerIdentity: UpstreamClientService["getServerIdentity"] = (
        serverId,
        includeDiagnostic = false,
        endpointId,
      ) =>
        Effect.gen(function* () {
          const server = yield* getServer(serverId);
          const endpoint =
            endpointId === undefined
              ? server.endpoints[0]
              : yield* endpointById(server, endpointId);
          if (endpoint === undefined)
            return yield* Effect.fail(new UpstreamUnavailable({ serverId }));
          return yield* serverIdentity(server, endpoint, includeDiagnostic, true);
        });

      const probeServerIdentity: UpstreamClientService["probeServerIdentity"] = (
        server,
        endpoint,
        includeDiagnostic = false,
      ) => serverIdentity(server, endpoint, includeDiagnostic, false);

      const probeServerName: UpstreamClientService["probeServerName"] = (server, endpoint) =>
        deadline(
          Effect.gen(function* () {
            const response = yield* fetchWithRedirects(
              server,
              endpoint,
              {
                serverId: server.id,
                generation: server.generation,
                path: "/System/Info/Public",
                method: "GET",
              },
              null,
            );
            const info = yield* decodeResponse(response, server.id, PublicServerName);
            return info.ServerName?.trim() || null;
          }),
          server.id,
        );

      const listSourceLibraries: UpstreamClientService["listSourceLibraries"] = (serverId) =>
        deadline(
          Effect.gen(function* () {
            const server = yield* getServer(serverId);
            if (
              !server.enabled ||
              server.health !== "healthy" ||
              eligibleEndpoints(server).length === 0
            ) {
              return yield* Effect.fail(new UpstreamUnavailable({ serverId }));
            }
            const folders = yield* request(
              {
                serverId,
                generation: server.generation,
                path: "/Library/VirtualFolders",
                method: "GET",
              },
              VirtualFolders,
            ).pipe(Effect.result);
            const source = (
              id: string,
              name: string,
              mediaType: SourceLibrary["mediaType"],
            ): SourceLibrary => ({
              id: id as SourceLibrary["id"],
              serverId: server.id,
              name,
              mediaType,
            });
            if (folders._tag === "Success") {
              return folders.success.flatMap((folder): ReadonlyArray<SourceLibrary> => {
                const mediaType = collectionMediaType(folder.CollectionType);
                return mediaType === null ||
                  folder.ItemId.trim() === "" ||
                  folder.Name.trim() === ""
                  ? []
                  : [source(folder.ItemId, folder.Name, mediaType)];
              });
            }
            if (
              folders.failure._tag !== "UpstreamNotFound" &&
              !(folders.failure._tag === "UpstreamRejected" && folders.failure.status === 403)
            )
              return yield* Effect.fail(folders.failure);

            const userRequest = <A>(path: (userId: string) => string, schema: Schema.Schema<A>) =>
              Effect.gen(function* () {
                // Authentication refresh can change the upstream user ID between requests.
                const current = yield* getServer(serverId);
                if (current.upstreamUserId === null)
                  return yield* Effect.fail(new UpstreamInvalidResponse({ serverId }));
                return yield* request(
                  {
                    serverId,
                    generation: server.generation,
                    path: path(current.upstreamUserId),
                    replayPath: path,
                    method: "GET",
                  },
                  schema,
                );
              });
            const views = yield* userRequest(
              (userId) => `/Users/${encodeURIComponent(userId)}/Views`,
              UserViews,
            );
            const libraries = yield* Effect.forEach(
              views.Items,
              (view) =>
                Effect.gen(function* () {
                  if (view.Id.trim() === "" || view.Name.trim() === "") return [];
                  const mediaType = collectionMediaType(view.CollectionType);
                  if (mediaType !== null) return [source(view.Id, view.Name, mediaType)];
                  if (view.CollectionType && !["folders", "mixed"].includes(view.CollectionType))
                    return [];
                  const inferred: Array<SourceLibrary> = [];
                  for (const [itemType, type] of [
                    ["Movie", "movies"],
                    ["Series", "series"],
                  ] as const) {
                    const query = new URLSearchParams({
                      ParentId: view.Id,
                      Recursive: "true",
                      IncludeItemTypes: itemType,
                      Limit: "1",
                      EnableTotalRecordCount: "false",
                    });
                    const sample = yield* userRequest(
                      (userId) => `/Users/${encodeURIComponent(userId)}/Items?${query}`,
                      ContentTypeProbe,
                    );
                    if (sample.Items.some((item) => item.Type === itemType))
                      inferred.push(source(view.Id, view.Name, type));
                  }
                  return inferred;
                }),
              // Untyped categories need two probes each; concurrent discovery can
              // exceed upstream rate limits even when each response is fast.
              { concurrency: 1 },
            );
            return libraries.flat();
          }),
          serverId,
          config.timeoutMs ?? UPSTREAM_LIST_DEADLINE_MS,
        );

      const resolvePlayback: UpstreamClientService["resolvePlayback"] = (version) =>
        Effect.gen(function* () {
          if (
            typeof version.capabilities !== "object" ||
            version.capabilities === null ||
            Array.isArray(version.capabilities)
          ) {
            return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: "unknown" }));
          }
          const details = version.capabilities as Record<string, unknown>;
          if (typeof details.serverId !== "string" || typeof details.url !== "string") {
            return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: "unknown" }));
          }
          const server = yield* getServer(details.serverId);
          if (server.generation !== version.serverGeneration) {
            return yield* Effect.fail(new ObsoleteGeneration({ serverId: server.id }));
          }
          if (
            !server.enabled ||
            server.health !== "healthy" ||
            eligibleEndpoints(server).length === 0
          ) {
            return yield* Effect.fail(new UpstreamUnavailable({ serverId: server.id }));
          }
          const url = yield* Effect.try({
            try: () => new URL(details.url as string),
            catch: () => new InvalidUpstreamUrl(),
          });
          yield* validateDestination(
            url,
            server,
            endpointForUrl(server, url),
            config.destinationPolicy,
            "registered-resource",
          );
          return { serverId: server.id, generation: server.generation, url: url.href };
        });

      const resolvePlaybackRedirect: UpstreamClientService["resolvePlaybackRedirect"] = (
        playback,
      ) =>
        Effect.gen(function* () {
          const server = yield* getServer(playback.serverId);
          if (server.generation !== playback.generation) {
            return yield* Effect.fail(new ObsoleteGeneration({ serverId: server.id }));
          }
          if (
            !server.enabled ||
            server.health !== "healthy" ||
            eligibleEndpoints(server).length === 0
          ) {
            return yield* Effect.fail(new UpstreamUnavailable({ serverId: server.id }));
          }
          const current = yield* Effect.try({
            try: () => new URL(playback.url),
            catch: () => new InvalidUpstreamUrl(),
          });
          yield* validateDestination(
            current,
            server,
            endpointForUrl(server, current),
            config.destinationPolicy,
            "registered-resource",
          );
          const attempts = endpointAttemptsForUrl(server, current);
          if (attempts.length === 0) return current;
          const headers = new Headers({
            accept: "*/*",
            range: "bytes=0-",
            "icy-metadata": "1",
            "user-agent": effectiveUserAgent(server, playback.clientUserAgent),
            "x-emby-authorization": embyAuthorization(server),
          });
          if (server.accessToken !== null) headers.set("x-emby-token", server.accessToken);
          for (let index = 0; index < attempts.length; index++) {
            const attempt = attempts[index]!;
            yield* validateDestination(
              attempt.url,
              server,
              attempt.endpoint,
              config.destinationPolicy,
            );
            const fetched = yield* fetchOnce(server, attempt.url, {
              method: "GET",
              headers,
              redirect: "manual",
            }).pipe(Effect.result);
            if (fetched._tag === "Failure") {
              if (index + 1 < attempts.length && endpointFailure(fetched.failure)) continue;
              return yield* Effect.fail(fetched.failure);
            }
            const response = fetched.success;
            if (response.body !== null)
              yield* Effect.promise(() => response.body!.cancel()).pipe(Effect.ignore);
            if (index + 1 < attempts.length && failoverStatuses.has(response.status)) continue;
            if (!redirects.has(response.status)) return attempt.url;
            const location = response.headers.get("location");
            if (location === null)
              return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: server.id }));
            const next = yield* Effect.try({
              try: () => new URL(location, attempt.url),
              catch: () => new InvalidUpstreamUrl(),
            });
            if (
              (next.protocol !== "http:" && next.protocol !== "https:") ||
              next.username !== "" ||
              next.password !== ""
            ) {
              return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: server.id }));
            }
            return next;
          }
          return yield* Effect.fail(new UpstreamUnavailable({ serverId: server.id }));
        });

      const requestResource: UpstreamClientService["requestResource"] = (input) =>
        Effect.gen(function* () {
          const transport = config.fetchRegisteredResource;
          if (transport === undefined)
            return yield* Effect.fail(new UpstreamUnavailable({ serverId: input.serverId }));
          const server = yield* getServer(input.serverId);
          if (server.generation !== input.generation) {
            return yield* Effect.fail(new ObsoleteGeneration({ serverId: input.serverId }));
          }
          if (
            !server.enabled ||
            server.health !== "healthy" ||
            eligibleEndpoints(server).length === 0
          ) {
            return yield* Effect.fail(new UpstreamUnavailable({ serverId: server.id }));
          }
          const initial = new URL(input.url);
          const configuredEndpoints = eligibleEndpoints(server);
          const endpointAttempts = endpointAttemptsForUrl(server, initial);
          let endpointFloor =
            endpointAttempts.length === 0
              ? -1
              : configuredEndpoints.indexOf(endpointAttempts[0]!.endpoint);
          const attempts: Array<{ readonly endpoint?: UpstreamEndpoint; readonly url: URL }> =
            endpointAttempts.length === 0 ? [{ url: initial }] : [...endpointAttempts];
          attempts: for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
            const attempt = attempts[attemptIndex]!;
            let current = attempt.url;
            const visited = new Set<string>();
            for (let redirectCount = 0; ; redirectCount++) {
              yield* validateDestination(
                current,
                server,
                endpointForUrl(server, current),
                config.destinationPolicy,
                "registered-resource",
              );
              if (visited.has(current.href))
                return yield* Effect.fail(new RedirectLoop({ serverId: server.id }));
              visited.add(current.href);
              const fetched = yield* Effect.tryPromise({
                try: (signal) =>
                  transport(
                    new Request(current, {
                      method: "GET",
                      redirect: "manual",
                      signal,
                      headers: {
                        accept: input.accept.join(", "),
                        "user-agent": effectiveUserAgent(server, input.clientUserAgent),
                      },
                    }),
                    {
                      server,
                      destinationPolicy: config.destinationPolicy,
                      isConnectedAddressAllowed: connectedAddressAllowed(config.destinationPolicy),
                    },
                  ),
                catch: () => new UpstreamUnavailable({ serverId: server.id }),
              }).pipe(
                Effect.timeout(timeoutMs),
                Effect.catchTag("TimeoutError", () =>
                  Effect.fail(new UpstreamTimeout({ serverId: server.id })),
                ),
                Effect.result,
              );
              const currentEndpoint = endpointForUrl(server, current);
              if (currentEndpoint !== undefined) {
                endpointFloor = Math.max(
                  endpointFloor,
                  configuredEndpoints.indexOf(currentEndpoint),
                );
              }
              const nextAttempt =
                currentEndpoint === undefined
                  ? undefined
                  : endpointAttemptsForUrl(server, current).find(
                      ({ endpoint }) => configuredEndpoints.indexOf(endpoint) > endpointFloor,
                    );
              if (fetched._tag === "Failure") {
                if (nextAttempt !== undefined && endpointFailure(fetched.failure)) {
                  attempts[attemptIndex + 1] = nextAttempt;
                  continue attempts;
                }
                return yield* Effect.fail(fetched.failure);
              }
              const response = fetched.success;
              if (nextAttempt !== undefined && failoverStatuses.has(response.status)) {
                if (response.body !== null)
                  yield* Effect.promise(() => response.body!.cancel()).pipe(Effect.ignore);
                attempts[attemptIndex + 1] = nextAttempt;
                continue attempts;
              }
              if (!redirects.has(response.status)) {
                const latest = yield* getServer(server.id);
                if (latest.generation !== input.generation) {
                  if (response.body !== null)
                    yield* Effect.promise(() => response.body!.cancel()).pipe(Effect.ignore);
                  return yield* Effect.fail(new ObsoleteGeneration({ serverId: server.id }));
                }
                return yield* Effect.acquireRelease(Effect.succeed(response), (value) =>
                  value.body === null
                    ? Effect.void
                    : Effect.promise(() => value.body!.cancel()).pipe(Effect.ignore),
                );
              }
              if (response.body !== null)
                yield* Effect.promise(() => response.body!.cancel()).pipe(Effect.ignore);
              if (redirectCount >= MAX_REDIRECTS) {
                return yield* Effect.fail(new RedirectLimitExceeded({ serverId: server.id }));
              }
              const location = response.headers.get("location");
              if (location === null)
                return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: server.id }));
              const next = yield* Effect.try({
                try: () => new URL(location, current),
                catch: () => new InvalidUpstreamUrl(),
              });
              if (current.protocol === "https:" && next.protocol === "http:") {
                return yield* Effect.fail(new HttpsDowngrade({ serverId: server.id }));
              }
              current = next;
            }
          }
          return yield* Effect.fail(new UpstreamUnavailable({ serverId: server.id }));
        });

      return UpstreamClient.of({
        request,
        authenticate,
        getServerIdentity,
        probeServerIdentity,
        probeServerName,
        listSourceLibraries,
        resolvePlayback,
        resolvePlaybackRedirect,
        requestResource,
        requestImage,
      });
    }),
  );
