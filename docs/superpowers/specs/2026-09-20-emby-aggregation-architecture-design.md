# Emby Aggregation Architecture Design

Date: 2026-09-20

## Status

Approved architecture for the first oh-my-emby release. This is the parent specification for the product. The Dashboard implementation details live in [Dashboard Frontend Design](./2026-09-20-dashboard-frontend-design.md).

This specification is authoritative over earlier exploratory drafts. In particular, the MVP uses on-demand federated queries and persistent cache; it does not perform background full-library scans.

## Product definition

oh-my-emby is an open-source, self-hosted Emby-compatible virtual server. One deployment connects to multiple upstream Emby servers and presents selected upstream libraries as one virtual Emby server.

Equivalent movies, series, seasons, and episodes are represented once. Every matching upstream copy remains available as a user-selectable media version. The first compatibility target is SenPlayer.

The product supports two deployment shapes from one codebase:

- Cloudflare Workers with D1, Cron Triggers, and Static Assets;
- one Docker container using Bun and SQLite.

The license is AGPL-3.0.

## Goals

- Accept multiple upstream Emby server URLs, usernames, passwords, and per-server User-Agent policy.
- Expose one Emby-compatible endpoint that existing clients can add as a server.
- Merge only resources whose external identities are provably equal.
- Expose all matching upstream copies as selectable media versions.
- Maintain one local user's unified watch, favorite, and resume state.
- Propagate user-state writes to matching upstream resources without making upstream availability part of the local write transaction.
- Resolve video playback to an upstream URL and redirect without proxying media bytes.
- Proxy images and subtitles only when direct client access is not viable.
- Run the same domain and protocol behavior on Workers/D1 and Docker/Bun/SQLite.
- Keep the MVP usable with approximately ten configured upstream sources.

## Non-goals

- Video transcoding, remuxing, decoding, or byte-stream proxying.
- Plex, Jellyfin, or other protocol compatibility in the first release.
- Multiple local users, roles, households, or administrators.
- Multiple independent virtual servers or aggregation groups inside one deployment. Separate groups use separate deployments.
- Fuzzy title matching, AI matching, or heuristic merging.
- Writing media metadata, artwork, library configuration, or files back to upstream servers.
- Full-library crawling, periodic catalog scans, scan cursors, or scan-based deletion detection.
- A hosted multi-tenant control plane.
- Guaranteed support for upstream media that can only be read with headers the client cannot send.

## System context

```text
                         +----------------------+
                         | Dashboard browser    |
                         | /dashboard/*         |
                         +----------+-----------+
                                    |
                                    | /api/dashboard/*
                                    v
+---------------+       +-----------+------------+       +----------------+
| Emby client   +------>| oh-my-emby virtual     +------>| Upstream Emby A|
| SenPlayer     | Emby  | server                 |       +----------------+
+---------------+ API   |                        |       +----------------+
                        | shared Effect core     +------>| Upstream Emby B|
                        | platform adapters      |       +----------------+
                        +-----------+------------+       +----------------+
                                    |
                          +---------+----------+
                          | D1 or SQLite       |
                          +--------------------+
```

One HTTP application owns three disjoint surfaces:

| Surface | Prefix | Purpose |
| --- | --- | --- |
| Emby-compatible API | Emby-native paths | Client discovery, libraries, metadata, user state, playback, images, and subtitles. |
| Dashboard API | `/api/dashboard/*` | Setup, authentication, upstream configuration, virtual libraries, and system status. |
| Dashboard SPA | `/dashboard/*` | Static React application and prefix-scoped SPA fallback. |

## Repository architecture

The repository is a pnpm workspace orchestrated by Turborepo:

```text
apps/
  server/
    src/
      core/                 # Platform-independent domain services
      api/                  # Emby and Dashboard HTTP contracts/handlers
      platform/
        workers/            # D1, Workers fetch, Cron, Static Assets
        bun/                # SQLite, Bun HTTP, filesystem assets
  dashboard/                # React SPA
packages/
  contracts/                # Shared Effect schemas and Dashboard HttpApi
```

The server uses Effect v4 exclusively and pins `effect@4.0.0-rc.112` exactly rather than with a range. Platform-neutral code depends on Effect service interfaces; only platform entry points construct concrete layers.

The Docker production runtime is Bun. The Bun adapter uses `@effect/platform-bun` and `@effect/sql-sqlite-bun`. Node.js is not part of the production image.

The Workers adapter uses the Workers runtime and D1 implementation. It does not import Bun or Node-only modules.

## Domain boundaries

### Upstream server

An upstream server record contains:

- stable local server ID;
- display name;
- base URL;
- upstream username and recoverable password;
- cached upstream access token and its validity metadata;
- User-Agent policy;
- enabled state;
- health and last-success metadata.

The service requires recoverable upstream credentials for unattended operation. The MVP treats access to D1 or the SQLite volume as part of the trusted deployment boundary. Passwords and tokens are write-only through the Dashboard API, are redacted from logs, and are never returned to the browser. Application-layer encryption is not claimed without a separately managed encryption key.

Upstream authentication is isolated per server. A failed or expired token triggers reauthentication for that server and cannot invalidate other servers.

### Virtual media library

A virtual library defines one user-visible Emby library and references one or more source libraries from enabled upstream servers. It has a stable local ID, name, media type, and source bindings.

All virtual libraries belong to the same virtual Emby server. The MVP does not expose independent user namespaces or server identities per library.

### Canonical item and source item

A canonical item is the stable local identity exposed to clients. A source item maps one upstream server item to that canonical identity and retains the upstream identifiers needed for metadata, user-state propagation, and playback resolution.

Canonical identity is global within one deployment, not scoped to a virtual library. The same canonical item may appear in multiple virtual libraries while retaining one local item ID and one set of source versions.

### Local user state

User state belongs to the canonical item and the sole local user. It includes the protocol fields required for watched state, favorite state, play count, and resume position.

Local state is authoritative for virtual-server responses. Upstream propagation is asynchronous and cannot roll back a successful local write.

## Identity and aggregation rules

Merging is deterministic and conservative.

### Movies and series

Two movies or two series merge only when they share an exact supported external ID, such as TMDB or IMDb, and their other present supported IDs do not conflict.

If two records have a matching TMDB ID but conflicting IMDb IDs, they remain separate. Type mismatches never merge.

### Seasons and episodes

An episode uses its own exact external ID when available. Otherwise its fallback identity is:

```text
canonical series identity + season number + episode number
```

Specials remain distinct through their season and episode numbers. Records without enough information for the fallback remain source-exclusive.

### Unidentified resources

An item without a safe canonical identity receives a source-exclusive local identity derived from its upstream server and item ID. It remains visible but never merges merely because its title, year, or runtime resembles another item.

### Multi-version representation

Every source item mapped to a canonical movie or episode contributes an Emby media source/version. Version labels identify the upstream server and useful source characteristics available from Emby metadata.

The client chooses the version. oh-my-emby does not silently collapse the list to a preferred source or force an automatic default-selection policy in the first release.

## On-demand federation and cache

The MVP has no full-library scan.

For a library, search, item-list, or detail request:

1. Resolve the virtual library and its enabled source bindings.
2. Fan out only to the relevant upstream Emby endpoints with bounded concurrency and per-source deadlines.
3. Normalize successful upstream payloads into source items.
4. Apply exact canonical identity rules.
5. Merge matching items and their media versions.
6. Persist the useful normalized result and source mappings in the local cache.
7. Return a protocol-compatible response, including partial results when policy permits.

The cache is keyed by upstream identity plus normalized request semantics. A credentials or source-binding change invalidates affected entries. Materialized merged query results retain enough ordering information to keep pagination stable for their cache lifetime.

Successful fresh data replaces the corresponding cached data. On a transient upstream failure, a still-usable cached response may be returned as stale; the Dashboard exposes that source's degraded status. A source timeout does not make other successful sources disappear.

Because discovery is request-driven, the local database contains only items and query results the user or client has actually reached. Removing an upstream removes it from future federation and media-source selection but does not erase canonical local user state.

Cron performs maintenance only:

- retry due user-state outbox entries;
- expire old query/cache entries;
- clean expired Dashboard sessions;
- run bounded health maintenance when configured.

Cron never crawls every upstream library.

## Upstream HTTP policy

Each upstream request is made through one shared upstream-client service. It owns:

- URL construction and normalization;
- upstream authentication and token refresh;
- configured User-Agent application;
- the minimal required Emby client/device identity headers;
- timeouts, bounded retries, and cancellation;
- response decoding and typed failure classification;
- secret-safe structured logging.

Headers are allowlisted. Arbitrary inbound client headers are not blindly forwarded to upstream servers.

The configured User-Agent applies to server-initiated upstream control requests, including authentication, metadata queries, and playback URL resolution. After a video redirect, the media request is made by the Emby client with that client's own User-Agent. An upstream that rejects the real client User-Agent on the final media request is incompatible with redirect-only playback; the MVP does not hide that limitation by proxying video.

## User-state writes and outbox

Only user state is written back to upstream servers.

For a watch, favorite, play-count, or resume mutation:

1. Validate the local user and canonical item.
2. In one database transaction, update local canonical user state and enqueue one outbox target for every currently mapped source item.
3. Return success from the virtual server after the local transaction commits.
4. Deliver upstream mutations asynchronously with idempotent target semantics.
5. Retry transient failures with bounded backoff.
6. Retain permanent failures for Dashboard diagnosis without reverting local state.

Repeated state changes may supersede older unsent values for the same user, canonical item, source item, and state field. Removing an upstream cancels delivery to that source but preserves local state.

Media metadata remains read-only. The service never edits upstream titles, external IDs, artwork, libraries, or files.

## Playback and resource delivery

### Video

Playback is redirect-only:

1. The Emby client selects a media source/version exposed by the virtual item.
2. oh-my-emby resolves that source against its upstream server using the server's authentication and User-Agent policy.
3. The virtual stream endpoint returns an HTTP 302 to the resolved upstream media URL.
4. Responsibility for the media response transfers to the client and upstream server.

oh-my-emby does not read the redirected response, observe its status, retry it, transform it, or proxy any video bytes. The target must be reachable by the client and must carry sufficient URL-based authorization or accept the client's own request headers.

### Images

Images use a conditional strategy:

- redirect when the upstream URL is directly usable by the client;
- proxy through oh-my-emby when upstream authorization/header requirements or network reachability require it;
- cache proxied image responses within bounded storage and response-cache policies.

Image proxy failures return an image-route error and do not affect video playback.

### Subtitles

Subtitle payloads may be proxied because they are bounded auxiliary resources and clients often need stable virtual-server URLs. Direct redirect remains allowed when the upstream URL is independently usable. Subtitle proxying must stream the upstream response and must not buffer unbounded payloads.

## Local identity and authentication

The first setup creates one username and password. That identity serves both surfaces:

- Emby-compatible authentication issues Emby access tokens for clients;
- Dashboard authentication issues opaque database-backed browser sessions.

Passwords are hashed with Web Crypto PBKDF2 using a unique random salt and stored parameters. Plaintext local passwords are never stored. Emby tokens and Dashboard session tokens are stored as hashes rather than reusable plaintext values.

Dashboard sessions are revocable and use a seven-day rolling inactivity window. Changing the local password revokes all Emby tokens and Dashboard sessions.

The user explicitly accepted first-visitor setup with no setup secret. Therefore an uninitialized public deployment can be claimed by the first visitor. This is a documented security property, not a protected bootstrap flow.

## Data model

Both D1 and SQLite implement the same logical schema and migrations:

| Entity | Purpose |
| --- | --- |
| `users` | Sole local user and password hash parameters. |
| `emby_tokens` | Hashed client access tokens and device metadata. |
| `dashboard_sessions` | Hashed browser sessions and rolling expiry. |
| `upstream_servers` | Connection, credential, UA, enabled, and health state. |
| `virtual_libraries` | User-visible library definitions. |
| `library_sources` | Virtual-to-upstream library bindings. |
| `canonical_items` | Stable virtual item identities and normalized metadata cache. |
| `source_items` | Upstream item mappings and version/playback metadata. |
| `user_state` | Canonical local watched/favorite/resume state. |
| `query_cache` | Normalized federated query snapshots and expiry. |
| `state_outbox` | Pending and failed upstream user-state writes. |
| `schema_migrations` | Applied database migration versions. |

Database adapters own SQL dialect details. Core services operate through repository interfaces and do not branch on D1 versus SQLite.

Schema migrations are forward, ordered, and shared. Deployment startup applies them before serving traffic; a failed migration prevents the service from accepting requests.

## HTTP and Effect architecture

Effect services form the server boundary:

```text
Emby handlers / Dashboard handlers
              |
              v
  Catalog federation + identity + user state + playback
              |
       +------+-------+----------------+
       |              |                |
UpstreamClient   Repositories      Outbox/Cron
       |              |                |
   fetch layer     D1 / SQLite      platform clock
```

The core contains no global mutable state and no runtime-specific imports. Request-scoped data, cancellation, logging spans, and deadlines travel through Effect context.

`packages/contracts` contains the Dashboard `HttpApi`, shared Effect Schemas, and typed public errors. Emby protocol schemas remain in the server because the Dashboard does not consume them.

Errors are classified into authentication, validation, not found, upstream unavailable, upstream rejected, timeout, and internal failures. Public responses never contain upstream passwords, tokens, raw headers, SQL, or stack traces.

## Deployment architecture

### Cloudflare Workers

One Worker deployment contains:

- the Effect Workers entry point;
- one D1 binding;
- Cron Triggers for bounded maintenance;
- one Static Assets binding for the Dashboard.

Workers upstream constraints are part of validation and documentation:

- upstream URLs must use `http:` or `https:`;
- direct fetches to IPv4 or IPv6 literals are unsupported;
- public DNS hostnames are required;
- nonstandard ports require the `allow_custom_ports` compatibility flag;
- public HTTPS with a valid certificate is the supported baseline;
- Cloudflare-proxied hostnames remain subject to Cloudflare's supported proxy ports.

The Worker handles application routes before Dashboard fallback so unknown API or Emby paths never become HTML.

### Docker

The Docker image contains the Bun server and prebuilt Dashboard assets. It runs one process and persists SQLite in one mounted data directory.

Docker supports the same public HTTPS upstream baseline and additionally permits administrator-configured LAN/private-network upstream hostnames or addresses. This is intentional for self-hosting and means the sole administrator is trusted to configure upstream destinations.

The image includes a health check but no bundled reverse proxy. TLS termination may be provided by the operator's existing Caddy, Traefik, nginx, or platform ingress.

## Dashboard

The Dashboard is a Vite React SPA served by the same application. It uses shadcn/ui, TanStack Router, TanStack Query, TanStack Form, Paraglide, and shared Effect schemas/HttpApi.

Its route, component, token, authentication, query, form, localization, and static-asset design is defined in [Dashboard Frontend Design](./2026-09-20-dashboard-frontend-design.md).

The first release includes only:

- first-run user and first-server setup;
- overview/status;
- upstream server configuration and connection test;
- virtual media library configuration;
- system/runtime status;
- language, theme, password, and logout controls.

It does not duplicate the Emby media-browsing experience.

## Failure behavior

- One failed upstream does not fail a federated request when other sources or usable cached results exist.
- A total miss with all sources unavailable is an upstream-unavailable error, not an empty library.
- Stale cache is labeled operationally in the Dashboard; protocol responses remain compatible with Emby clients.
- A failed upstream user-state write remains in the outbox and does not undo local state.
- A failed playback-resolution request affects only the selected version; the client may select another exposed version.
- Invalid or conflicting external IDs isolate items instead of merging them.
- Secrets are redacted at logging and API serialization boundaries.

## Observability and operations

Structured logs include request ID, route, upstream server ID, duration, cache outcome, retry outcome, and typed failure category. They exclude credentials, tokens, authorization headers, media URLs containing tokens, and request bodies that may contain secrets.

A minimal public health endpoint reports process/runtime availability without database or upstream details. Authenticated Dashboard status reports database connectivity, cache maintenance, outbox depth, and per-upstream health.

Metrics and tracing stay dependency-light in the MVP. Platform-native Worker logs and Docker stdout are the required sinks.

## Testing strategy

Testing follows the architectural seams:

- pure tests for external-ID canonicalization and conflict isolation;
- contract tests for Emby response shapes required by SenPlayer;
- shared repository behavior tests against D1-compatible and SQLite adapters;
- federated-query tests for deduplication, partial failure, stale cache, ordering, and pagination snapshots;
- user-state transaction and outbox retry tests;
- playback tests proving the selected version resolves to one 302 and no media body is proxied;
- image/subtitle redirect-versus-proxy tests;
- authentication and token/session revocation tests;
- platform integration tests for Workers and Docker routing;
- real SenPlayer smoke tests for server login, library listing, details, version selection, playback redirect, watched state, and resume state.

Passing unit tests do not substitute for starting each deployment artifact and exercising its real HTTP routes.

## MVP acceptance criteria

The release is acceptable when all of the following are demonstrated:

1. A fresh Workers deployment and a fresh Docker deployment can create the sole user and configure upstream servers.
2. At least ten configured sources can participate in the performance test without unbounded fan-out or memory growth.
3. Exact TMDB/IMDb matches appear as one canonical item with multiple selectable versions.
4. Conflicting or unidentified resources remain separate.
5. Movies and series libraries work through the SenPlayer client flow.
6. A watched/favorite/resume write commits locally and retries failed upstream propagation through the outbox.
7. Selecting a version produces a 302 to its upstream media URL and oh-my-emby transfers no video bytes.
8. Images and subtitles use the documented conditional redirect/proxy behavior.
9. One unavailable source degrades results without erasing healthy-source data.
10. Dashboard deep links and `/api/dashboard/*` error routing behave identically on Workers and Docker.
11. Logs and Dashboard responses reveal no stored upstream secret or access token.

## Deliberate simplifications

- One user and one virtual server per deployment; use another deployment for another group.
- Exact external IDs only; uncertain matches remain separate.
- Query-driven cache rather than a complete local catalog.
- Local-first user state with an outbox rather than a distributed transaction.
- 302-only video delivery rather than a media proxy.
- Platform database access is trusted; no misleading at-rest-encryption claim without external key management.
- Approximately ten sources define the initial performance target; increase complexity only after measurement.
