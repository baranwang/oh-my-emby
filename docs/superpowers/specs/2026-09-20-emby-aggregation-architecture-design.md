# Emby Aggregation Architecture Design

Date: 2026-09-20

## Status

Approved architecture for the first oh-my-emby release. This is the parent specification for the product. The Dashboard implementation details live in [Dashboard Frontend Design](./2026-09-20-dashboard-frontend-design.md).

This specification is authoritative over earlier exploratory drafts. In particular, the MVP uses on-demand federated queries and persistent cache; it does not perform background full-library scans.

## Product definition

oh-my-emby is an open-source, self-hosted Emby-compatible virtual server. One deployment connects to multiple upstream Emby servers and presents selected upstream libraries as one virtual Emby server.

Equivalent movies, series, seasons, and episodes are represented once when their identities can be proven compatible. Every matching copy discovered from eligible upstream sources is exposed as a user-selectable media version. Detail and playback preparation perform bounded exact-ID enrichment because list/search federation alone cannot prove version completeness. The initial compatibility targets are SenPlayer and Rex; each client requires its own captured runtime evidence.

The product supports two deployment shapes from one codebase:

- Cloudflare Workers with D1, Cron Triggers, and Static Assets;
- one Docker container using Bun and SQLite.

The license is AGPL-3.0.

## Goals

- Accept multiple upstream Emby server URLs, usernames, passwords, and per-server User-Agent policy.
- Expose one Emby-compatible endpoint that existing clients can add as a server.
- Merge only resources whose external identities are provably equal.
- Expose every discovered, identity-compatible upstream media source as a selectable version and report completeness relative to the eligible sources that answered within the request budget.
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
- Implicitly enumerating every undiscovered episode when a series or season receives a user-state write.

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

| Surface             | Prefix             | Purpose                                                                              |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| Emby-compatible API | Emby-native paths  | Client discovery, libraries, metadata, user state, playback, images, and subtitles.  |
| Dashboard API       | `/api/dashboard/*` | Setup, authentication, upstream configuration, virtual libraries, and system status. |
| Dashboard SPA       | `/dashboard/*`     | Static React application and prefix-scoped SPA fallback.                             |

## Repository architecture

The repository uses Bun workspaces orchestrated by Turborepo. Bun is the sole package manager and script runner; the repository commits only `bun.lock`:

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
- verified upstream catalog instance ID;
- display name;
- base URL;
- upstream username and recoverable password;
- cached upstream access token and its validity metadata;
- User-Agent policy;
- monotonically increasing configuration generation;
- enabled state;
- health and last-success metadata.

The service requires recoverable upstream credentials for unattended operation. The MVP treats access to D1 or the SQLite volume as part of the trusted deployment boundary. Passwords and tokens are write-only through the Dashboard API, are redacted from logs, and are never returned to the browser. Application-layer encryption is not claimed without a separately managed encryption key.

The stable local server ID names one immutable upstream catalog namespace, not a reusable connection slot. Source-exclusive identity is derived from the verified upstream catalog instance ID plus upstream item ID. Credential rotation does not create a new namespace. An endpoint edit may retain the namespace only after the new endpoint reports the same stable Emby server identity; until then it may be saved but remains ineligible for cached mapping reuse, federation, playback, and outbox delivery. An endpoint that resolves to another catalog requires a new local server record and new source-library bindings. Existing canonical IDs and local state remain retained, and any cross-catalog consolidation still uses the exact-ID cluster rules.

Upstream authentication is isolated per server. A failed or expired token triggers reauthentication for that server and cannot invalidate other servers. Changing the base URL, username, password, or authentication policy increments the configuration generation, clears cached tokens, and makes results from older in-flight requests ineligible for persistence. If an upstream cannot provide a stable server identity, endpoint replacement cannot reuse its prior catalog namespace.

### Virtual media library

A virtual library defines one user-visible Emby library and references one or more source libraries from enabled upstream servers. It has a stable local ID, name, media type, and source bindings.

All virtual libraries belong to the same virtual Emby server. The MVP does not expose independent user namespaces or server identities per library.

Source eligibility is global to the deployment: a source item or media version is eligible while its server is enabled and its source library is referenced by at least one enabled virtual-library binding. Removing one binding does not disable a source that remains referenced by another binding. Cached metadata may be retained after removal, but an ineligible source cannot appear in a response, resolve playback, or receive an outbox delivery.

### Canonical item and source item

A canonical item is the stable opaque local identity exposed to clients. A source item maps one upstream server item and server configuration generation to that canonical identity and retains the upstream identifiers needed for metadata, user-state propagation, and playback resolution.

Canonical identity is global within one deployment, not scoped to a virtual library. The same canonical item may appear in multiple virtual libraries while retaining one local item ID and one set of source versions.

Canonical IDs do not change when metadata is refreshed or an external-ID alias is learned. When two already-issued canonical records can be safely consolidated, the older record survives, the retired ID remains a permanent alias, and the highest local user-state revision wins. A late conflict never silently splits a canonical item or moves its user state; the new mapping is quarantined for diagnosis.

### Local user state

User state belongs to the canonical item and the sole local user. It includes the protocol fields required for watched state, favorite state, play count, and resume position.

Local state is authoritative for virtual-server responses. Upstream propagation is asynchronous and cannot roll back a successful local write.

Initial local state is neutral: upstream watched, favorite, play-count, and resume values are not implicitly imported. A state write applies to the addressed canonical item only. Marking a series or season does not enumerate or mutate undiscovered descendants in the MVP.

## Identity and aggregation rules

Merging is deterministic and conservative. External IDs are typed claims, for example `tmdb:movie`, `tmdb:tv`, and `imdb:title`; values from different namespaces never compare as equal.

### Movies and series

Two movies or two series merge only when they share an exact supported external-ID claim and their complete known claim sets are cluster-compatible. A canonical cluster may contain at most one value for each typed provider namespace.

If X and Z contain conflicting IMDb claims, a sparse bridge record Y cannot merge both merely because each pair shares the same TMDB claim. A record that would join incompatible clusters is marked ambiguous and remains source-exclusive. Type mismatches never merge.

Later enrichment may attach a compatible claim or safely consolidate two clusters, but it cannot create a conflicting cluster. Identity claims and aliases outlive disposable metadata and query-cache entries.

### Seasons and episodes

A season identity is its canonical series identity plus season number. Season zero represents specials and remains distinct from numbered seasons. When a child arrives before its parent, the service performs bounded parent hydration; if the canonical series still cannot be established, the child remains source-exclusive until later enrichment.

An episode uses its own exact external ID when available. Otherwise its fallback identity is:

```text
canonical series identity + season number + episode number
```

Specials remain distinct through their season and episode numbers. An explicit episode ID learned later becomes an alias without changing the issued canonical ID. The numerical fallback assumes compatible episode ordering; combined episodes, conflicting numbering, and records without enough information remain source-exclusive unless their own exact external IDs match.

### Unidentified resources

An item without a safe canonical identity receives a source-exclusive local identity derived from its verified upstream catalog instance ID and item ID. It remains visible but never merges merely because its title, year, or runtime resembles another item.

### Multi-version representation

Every upstream media source mapped to a canonical movie or episode contributes a virtual version. Its stable identity includes upstream server ID, configuration generation, item ID, and upstream media-source ID. One upstream item may therefore contribute multiple versions. Version labels identify the upstream server and useful source characteristics available from Emby metadata.

The client chooses the version when it supplies a media-source ID. oh-my-emby does not silently collapse the list to a preferred source. If a client omits selection, the server uses the first version in a stable ordering defined by virtual-library source order, server ID, item ID, and media-source ID; this is a protocol fallback, not a quality preference.

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

Federation always requests the provider-ID projection needed for identity, independently of the fields requested by the client. Opening details or preparing playback additionally performs bounded exact-provider-ID lookups across eligible source bindings, with positive and negative caching. It never substitutes fuzzy title search or a full-library scan. Version completeness means all compatible versions found among eligible sources that answered or had valid exact-lookup cache entries; unavailable or budget-exhausted sources remain explicitly incomplete.

The cache has three separate lifecycles:

- projection-aware source metadata, merged without allowing a lightweight list projection to erase richer identity or playback fields;
- query generations containing ordered canonical IDs and per-source continuation positions;
- resolved playback capabilities and URLs, bounded by their own upstream expiry.

Credentials, server generation, or source-binding changes invalidate affected entries. Authentication rejection, explicit not-found results, and generation changes do not use stale fallback. Cache expiry may remove metadata and query generations but never removes canonical identity, aliases, or local user state. A fresh cache hit avoids upstream fan-out until its freshness window expires.

### Pagination generations

Offset pagination is implemented over a server-owned query generation keyed by local user/device, virtual library, and normalized query excluding offset and limit. The generation stores ordered canonical IDs, published ordinals, per-source continuation state, source participation, and whether every source is exhausted.

`ParentId` is optional for `/Items`, `/Users/{id}/Items`, and `/Users/{id}/Items/Latest`. Omitting it selects all enabled virtual libraries, deduplicates shared source bindings, and uses one global query generation. Its concurrency limit (four) and materialization/scan limit (2,000) apply across the entire query, not separately per library. The existing generation table uses the first enabled library as a cache-lifetime foreign-key anchor only; the actual query key retains a distinct global scope. Scope changes, including disabled bindings and servers used by local-state membership, cannot reuse the previous membership snapshot. No enabled libraries produce an empty result without creating an anchored generation.

To serve a page, the federation layer performs bounded refill until the requested window is full or all participating sources are exhausted. Already published ordinals never move inside that generation. Ordering uses the normalized requested sort followed by canonical ID as a deterministic tie-breaker. A refresh or expired generation starts a new ordering; deep offsets beyond the configured materialization budget return a typed limit error rather than unbounded work.

When all sources are exhausted, `TotalRecordCount` is exact. Otherwise it is a provisional continuation count: at least the materialized count and at least one item beyond the returned window when unread upstream rows remain. Because later rows may deduplicate or fail local filters, this value is not a mathematical lower bound on the final distinct count; it may overestimate and decrease, and the final request may return an empty terminal page. SenPlayer compatibility tests must confirm that evolving and downward-corrected counts continue pagination correctly; the service never labels the provisional value a complete-library count.

State-independent catalog data is cached separately from local state. Positive favorite, played-history, and resume membership come from canonical local state and hydrate already-known IDs without an upstream catalog scan. Other state filters are applied locally after discovery with bounded refill. A relevant user-state write invalidates state-dependent filter and sort generations. Temporarily unhealthy upstreams do not hide already-known local resume/history entries; disabled or removed sources do.

Canonical display metadata uses the first fresh eligible source by virtual-library source order, then server ID and item ID; missing fields may be filled from compatible sources without overwriting present fields. Query generations persist their materialized sort values, so later metadata enrichment cannot reorder already published ordinals.

Successful fresh data replaces the corresponding cache projection. On a classified transient upstream failure, a still-usable cached response may be returned as stale; the Dashboard exposes that source's degraded status. A source timeout does not make other successful sources disappear, and absence from one successful page is never deletion evidence.

Because discovery is request-driven, the local database contains only items and query results the user or client has actually reached. Removing an upstream removes it from future federation and media-source selection but does not erase canonical local user state.

One bounded `runMaintenance` operation performs maintenance only:

- retry due user-state outbox entries;
- expire old query/cache entries;
- clean expired Dashboard sessions;
- run bounded health maintenance when configured.

Workers scheduled events and a Bun process-owned timer invoke the same operation. Work is claimed through database leases so overlapping invocations are safe. Correctness does not depend on a detached request fiber or `waitUntil()` surviving indefinitely. Maintenance never crawls every upstream library.

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

Authenticated control requests use manual redirect handling with at most three hops. Every hop revalidates `http:`/`https:`, destination policy, and downgrade rules. Requests start at an administrator-saved endpoint and control redirects stay on that endpoint's exact origin; a cross-origin redirect is rejected before another server-side request. Credentials and application identity headers are never forwarded across origins. Client-side video redirects may target a different HTTP or HTTPS media origin because oh-my-emby does not fetch the redirected video. Server-side image and subtitle fetching stays closed until a transport can validate the connected destination on every hop. Connection tests follow the same policy.

Public image and subtitle endpoints accept only registered source/version/resource identifiers, never a caller-provided URL. Docker's intentional ability to contact administrator-configured LAN upstreams does not grant arbitrary URLs returned by those upstreams access to unrelated private destinations.

The configured User-Agent applies to server-initiated upstream control requests, including authentication, metadata queries, and playback URL resolution. After a video redirect, the media request is made by the Emby client with that client's own User-Agent. An upstream that rejects the real client User-Agent on the final media request is incompatible with redirect-only playback; the MVP does not hide that limitation by proxying video.

## User-state writes and outbox

Only user state is written back to upstream servers.

User state is a versioned desired-state record. For a watch, favorite, play-count, or resume mutation:

1. Validate the local user and canonical item.
2. In one database transaction, increment the local state revision, update canonical desired state, and upsert one outbox target for every currently eligible source item.
3. Return success from the virtual server after the local transaction commits.
4. Claim due targets with a lease and deliver absolute upstream setters when supported.
5. Retry transient failures with bounded backoff.
6. Retain permanent failures for Dashboard diagnosis without reverting local state.

Each target retains desired and delivered revisions until safe compaction. Acknowledgement succeeds only when the claimed revision still matches the desired revision. A stale in-flight completion never deletes or acknowledges newer work; if it may have overwritten a newer remote value, the current desired revision is made due again from canonical local state.

Lease expiry, owner loss, timeout after dispatch, and every ambiguous delivery outcome create a durable reconciliation obligation. A newer successful acknowledgement does not clear that obligation. While the target remains eligible, maintenance periodically reapplies the latest canonical desired state even when `deliveredRevision` equals `desiredRevision`; targets with uncertain older attempts are not compacted. This is bounded recurring work over already-known state targets, not catalog reconciliation or a library scan. Under eventual upstream availability and eventual completion of earlier requests, the latest desired state is eventually the last applied write. This provides at-least-once convergence, not exactly-once remote mutation.

Coupled fields such as played, play count, and resume position are coalesced as one desired-state payload. Playback events are folded by local playback session so duplicate start/stop reports do not increment play count repeatedly, delayed progress cannot overwrite a newer session, and seeking backward remains valid.

When a new source mapping is discovered, the latest locally edited state is enqueued for that target. Resume propagation records the last-played version; applying the same position to a different cut is best-effort and is never represented as timeline equivalence. Removing an upstream cancels delivery to that source but preserves local state.

Media metadata remains read-only. The service never edits upstream titles, external IDs, artwork, libraries, or files.

## Playback and resource delivery

### Video

Playback is redirect-only:

1. The Emby client selects a virtual media-source ID exposed by the virtual item, or triggers the stable protocol fallback when it sends none.
2. oh-my-emby resolves that source against its upstream server using the server's authentication and User-Agent policy.
3. PlaybackInfo preserves the selected upstream source's stream indexes and advertises only capabilities the virtual server can honor; every video entry point is rewritten through the virtual stream endpoint.
4. The virtual stream endpoint returns an HTTP 302 to the resolved upstream media URL with `Cache-Control: private, no-store`.
5. Responsibility for the media response transfers to the client and upstream server.

oh-my-emby does not read the redirected response, observe its status, retry it, transform it, or proxy any video bytes. The target must be reachable by the client and must carry sufficient URL-based authorization or accept the client's own request headers.

An authenticated media redirect may disclose to that authorized Emby device the token or signed capability embedded in the upstream URL. This is the only exception to the general rule that public response DTOs contain no upstream authorization material. Redirect targets and token-bearing media URLs are never logged or cached as ordinary metadata. Local logout or password change prevents future resolution but cannot recall an upstream capability already delivered to a client.

### Images

Images use a conditional strategy:

- redirect when the upstream URL is directly usable by the client;
- proxy through oh-my-emby when upstream authorization/header requirements or network reachability require it;
- cache proxied image responses within bounded storage and response-cache policies.

Image requests resolve registered source/resource IDs and authenticate before cache access. The proxy branch is unavailable until a transport can validate the connected destination on every hop; it fails closed rather than accepting a global resource-origin allowlist. When available, proxy responses allowlist MIME types, count bytes, enforce deadlines, strip unsafe headers, and keep the upstream Effect scope alive until stream completion or cancellation. Cached payloads use a bounded platform cache rather than unbounded D1 blobs. Image proxy failures return an image-route error and do not affect video playback.

### Subtitles

Subtitle payloads may be proxied because they are bounded auxiliary resources and clients often need stable virtual-server URLs. Direct redirect remains allowed when the upstream URL is independently usable; otherwise the request fails closed until a peer-validating proxy transport exists. Subtitle identity includes the selected virtual media source and upstream stream index. When available, proxying applies format/MIME, byte, deadline, and header limits and must not buffer unbounded payloads. The MVP supports pass-through text and supported external subtitle formats only; it does not burn in, extract, or transform embedded/bitmap subtitles.

## Local identity and authentication

The first setup creates one username and password. That identity serves both surfaces:

- Emby-compatible authentication issues Emby access tokens for clients;
- Dashboard authentication issues opaque database-backed browser sessions.

Passwords are hashed with Web Crypto PBKDF2 using a unique random salt and stored parameters. Plaintext local passwords are never stored. Emby tokens and Dashboard session tokens are stored as hashes rather than reusable plaintext values.

Dashboard sessions are revocable and use a seven-day rolling inactivity window. Changing the local password revokes all Emby tokens and Dashboard sessions.

The user explicitly accepted first-visitor setup with no setup secret. Therefore an uninitialized public deployment can be claimed by the first visitor. This is a documented security property, not a protected bootstrap flow.

The database enforces a singleton user and performs first claim atomically. Committing the account marks the instance initialized; failure while configuring the first upstream leaves an authenticated instance with zero upstreams and a resumable setup flow, never a newly claimable instance.

The user row carries an authentication generation. Login verifies and conditionally issues a token/session against that generation, while password change increments it and revokes both token families in the same transaction. This fences a concurrent login that began with the old password. Login and setup attempts are rate-limited, and PBKDF2 parameters are measured for both Workers and Bun before release.

Dashboard writes require a valid `Origin` whose host and port match the request's `Host`; missing, malformed, or mismatched origins are rejected. Public access requires HTTPS, with HTTP allowed only for localhost development. Safe reads need no `Origin`. The browser sends `Host` automatically, so no public-origin deployment setting is needed. Authentication and host-only `HttpOnly`, `Secure`, `SameSite=Lax` session cookies remain mandatory. The application ignores `X-Forwarded-*` headers; login and setup limits use the actual Bun connection address or Cloudflare's platform-provided client address, never a caller-supplied forwarded IP.

## Data model

Both D1 and SQLite implement the same logical schema and migrations:

| Entity                   | Purpose                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `users`                  | Sole local user and password hash parameters.                                                                                |
| `emby_tokens`            | Hashed client access tokens and device metadata.                                                                             |
| `dashboard_sessions`     | Hashed browser sessions and rolling expiry.                                                                                  |
| `upstream_servers`       | Immutable catalog namespace, verified upstream identity, connection generations, credentials, UA, enabled, and health state. |
| `virtual_libraries`      | User-visible library definitions.                                                                                            |
| `library_sources`        | Virtual-to-upstream library bindings.                                                                                        |
| `canonical_items`        | Stable virtual item identities, type, and durable identity state.                                                            |
| `canonical_aliases`      | Permanent aliases from safely consolidated public IDs.                                                                       |
| `identity_claims`        | Typed external-ID claims, ambiguity, and quarantine state.                                                                   |
| `source_items`           | Upstream item mappings, source-library membership, and configuration generation.                                             |
| `source_media_versions`  | Upstream media-source identities and bounded playback capability metadata.                                                   |
| `user_state`             | Canonical local watched/favorite/resume state.                                                                               |
| `source_metadata_cache`  | Projection-aware normalized metadata and freshness.                                                                          |
| `query_generations`      | Query identity, source continuation state, expiry, and exhaustion.                                                           |
| `query_generation_items` | Bounded ordered membership rows rather than one unbounded JSON snapshot.                                                     |
| `state_outbox`           | Revisioned desired-state targets, delivered revisions, leases, retries, uncertainty obligations, and safe failures.          |
| `schema_migrations`      | Applied database migration versions.                                                                                         |

Database adapters own SQL dialect details. Core services operate through repository interfaces and do not branch on D1 versus SQLite. The state-and-outbox write is one repository command: SQL updates state/revision and creates eligible targets atomically without upstream HTTP inside the transaction. D1 uses a transactional prepared-statement batch with SQL-side conditions; SQLite provides equivalent semantics.

Schema migrations are forward, ordered, and shared as files, while activation is platform-specific. Workers migrations run as a serialized deployment step before activating the new Worker. Bun applies migrations before listening. A failed migration blocks the new version rather than claiming to stop an already-running old deployment. Expand/contract migrations preserve overlap compatibility; incompatible changes require an explicit maintenance procedure.

A repository conformance suite fixes foreign-key behavior, integer/boolean/time encoding, ordering, transaction completion, and crash/reopen semantics across real D1 integration tests and Bun SQLite. A SQLite approximation alone is not evidence of D1 parity.

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

Errors are classified into authentication, validation, not found, upstream unavailable, upstream rejected, timeout, materialization limit, and internal failures. Dashboard JSON, ordinary Emby DTOs, logs, and error responses never contain upstream passwords, tokens, raw headers, token-bearing media URLs, SQL, or stack traces. The authenticated redirect exception is limited to `Location` on media/resource routes.

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
- custom-port behavior must be enabled by a compatibility date on or after 2024-09-02 or by the explicit `allow_custom_ports` compatibility flag;
- public HTTPS with a valid certificate is the supported baseline;
- Cloudflare-proxied hostnames remain subject to Cloudflare's supported proxy ports.

The Worker handles application routes before Dashboard fallback so unknown API or Emby paths never become HTML. D1 migrations run outside request/cold-start handling as part of deployment activation.

### Docker

The Docker image contains the Bun server and prebuilt Dashboard assets. It runs one process and persists SQLite in one mounted data directory.

Docker supports the same public HTTPS upstream baseline and additionally permits any HTTP or HTTPS upstream hostname or address saved by the authenticated administrator, including LAN, IP-literal, and loopback endpoints. Saving that exact endpoint authorizes access to it; no second private-host allowlist is required. Workers retain their public-hostname and IP-literal restrictions and cannot reach the operator's private LAN.

The image includes a health check but no bundled reverse proxy. Production Dashboard access requires an externally reachable HTTPS origin so its mandatory `Secure` cookie works. TLS termination is supplied by the operator's existing Caddy, Traefik, nginx, or platform ingress; plain HTTP is limited to an explicit localhost development mode.

Neither deployment requires `PUBLIC_ORIGIN`, `TRUSTED_PROXIES`, `PRIVATE_UPSTREAM_HOSTS`, or `REGISTERED_RESOURCE_ORIGINS`; existing values are ignored after upgrade. The reverse proxy must preserve the public `Host`, and the application does not trust forwarded headers. Client-facing endpoints are derived from the browser's current origin. A Bun process-owned timer invokes `runMaintenance`; retry correctness remains database-backed and survives process restart.

## Dashboard

The Dashboard is a Vite React SPA served by the same application. It uses shadcn/ui, TanStack Router, TanStack Query, TanStack Form, Paraglide, and shared Effect schemas/HttpApi.

Its route, component, token, authentication, query, form, localization, and static-asset design is defined in [Dashboard Frontend Design](./2026-09-20-dashboard-frontend-design.md).

The first release includes only:

- first-run user and first-server setup;
- overview/status;
- upstream server configuration and connection test;
- virtual media library configuration;
- upstream source-library discovery;
- system/runtime status;
- safe outbox failure diagnosis and retry status;
- language, theme, password, and logout controls.

It does not duplicate the Emby media-browsing experience.

## SenPlayer compatibility contract

Protocol compatibility is accepted from captured behavior, not from Emby documentation alone. Release evidence in `docs/compatibility/senplayer.md` records the tested SenPlayer platform/build and the observed request sequence for login, server identity, views, list/detail fields, pagination, version selection, PlaybackInfo, actual stream requests, redirects, seeking, audio/subtitle selection, playback reports, and any `/emby` path aliases.

The virtual protocol advertises only capabilities demonstrated by the selected media source and implemented by oh-my-emby. A successful upstream connection test proves control-plane reachability only; it does not prove client reachability, redirect authorization, User-Agent compatibility, or SenPlayer version selection.

### Rex compatibility additions

Captured Rex requests require global lists without `ParentId`, `/Users/{id}/Items/Resume`, and `/Studios`. Resume is a dedicated authenticated list route, not an item ID; it uses local unplayed positions and defaults to descending local activity time. Local path/query user IDs must match the authenticated user.

Upstream catalog and studio requests carry the configured upstream account's `UserId`, not the local user ID. This is required by user-dependent sorts such as Rex's `IsFavoriteOrLiked,Random`; omitting it caused a real upstream HTTP 500. Authentication replay rebuilds the query with the refreshed upstream user ID.

Studio discovery is bounded to 2,000 names in total, sharing the request budget across eligible source bindings and supplying each upstream's own `UserId` and `ParentId`. Names are merged case-insensitively and exposed through reversible local `studio:` IDs, never upstream IDs. Item queries translate local `StudioIds` or pipe-delimited `Studios` names into upstream name filters. Truncated or failed sources remain incomplete internally; the response count describes the discovered studio snapshot and terminates there instead of advertising pages that cannot be fetched. Exhaustive studio enumeration beyond that bound is not claimed.

The shared Bun/Workers HTTP acceptance flow covers login, views, global and scoped items, detail, local resume/history, and studio filtering using fixture upstreams. This is separate from real Rex UI, real upstream, and actual playback verification; passing that suite alone does not certify the client.

A real-upstream HTTP replay on 2026-09-23 used an isolated copy of the local database and the production Bun runtime: global pages returned 30 items each without duplicate IDs, scoped items/detail/PlaybackInfo returned 200, and video/image entries returned 302. Resume/history returned empty local-state lists; studio discovery returned 1,999 distinct names and a studio-filtered query returned three items. The probe blocked upstream state writes and did not follow the video redirect or download media bytes. Native Rex UI rendering and actual playback remain unverified.

## Failure behavior

- One failed upstream does not fail a federated request when other sources or usable cached results exist.
- A total miss with all sources unavailable is an upstream-unavailable error, not an empty library.
- Stale cache is labeled operationally in the Dashboard; protocol responses remain compatible with Emby clients.
- A failed upstream user-state write remains in the outbox and does not undo local state.
- A failed playback-resolution request affects only the selected version; the client may select another exposed version.
- Invalid or conflicting external IDs isolate items instead of merging them.
- An obsolete server generation cannot persist cache/mappings, resolve playback, or acknowledge outbox work.
- Secrets are redacted at logging and API serialization boundaries.

## Observability and operations

Structured logs include request ID, route, upstream server ID, duration, cache outcome, retry outcome, and typed failure category. They exclude credentials, tokens, authorization headers, media URLs containing tokens, and request bodies that may contain secrets.

A minimal public health endpoint reports process/runtime availability without database or upstream details. Authenticated Dashboard status reports database connectivity, cache maintenance, outbox depth, typed non-secret outbox failures, and per-upstream health.

Metrics and tracing stay dependency-light in the MVP. Platform-native Worker logs and Docker stdout are the required sinks.

## Testing strategy

Testing follows the architectural seams:

- pure tests for cluster-wide external-ID canonicalization, sparse bridges, late claims, aliases, and conflict quarantine;
- contract tests for Emby response shapes required by SenPlayer;
- shared repository conformance tests against real D1 and Bun SQLite adapters;
- federated-query tests for exact-ID enrichment, incomplete sources, deduplication, partial failure, projection-safe stale cache, ordering, provisional count increases/decreases, terminal empty pages, and pagination generations;
- local-state membership tests for favorites, watched, and resume filters;
- user-state transaction and outbox tests for revision races, leases, observed and unobserved late completions, persistent uncertainty reconciliation, new mappings, and retries;
- playback tests proving each upstream media-source identity resolves through one local entry point to one private/non-cacheable 302 and no media body is proxied;
- image/subtitle redirect-versus-proxy tests;
- authentication tests for atomic claim, concurrent password change, and token/session revocation;
- upstream redirect-policy and obsolete-generation race tests;
- platform integration tests for Workers and Docker migrations, maintenance, routing, missing assets, and traversal safety;
- real SenPlayer smoke tests for server login and identity, library/detail request shapes, evolving counts and pagination, version selection, PlaybackInfo, actual stream request/redirect handling, seeking, audio/subtitle selection, watched/resume reports, and any observed `/emby` aliases.

Passing unit tests do not substitute for starting each deployment artifact and exercising its real HTTP routes.

## MVP acceptance criteria

The release is acceptable when all of the following are demonstrated:

1. A fresh Workers deployment and a fresh Docker deployment can create the sole user and configure upstream servers.
2. At least ten configured sources can participate within implementation-plan budgets for concurrency, page size, response bytes, deadlines, SQL parameters, chunked generation rows, and retained storage, without unbounded fan-out or memory growth.
3. Exact compatible TMDB/IMDb clusters appear as one canonical item with every media source discovered by list or bounded exact-ID enrichment exposed as a selectable version.
4. Sparse bridge conflicts, contradictory IDs, combined episodes, and unidentified resources remain separate or quarantined without moving existing user state.
5. Movies and series libraries, provisional count increases/decreases, terminal empty pages, version selection, seeking, tracks, and state reporting work through a captured real SenPlayer client flow.
6. A watched/favorite/resume write commits locally, controls local query membership, and converges through a revision-safe outbox even when writes reorder or a mapping appears later.
7. Selecting a version produces a private/non-cacheable 302 to its upstream media URL, discloses no capability outside that authenticated response, and transfers no video bytes through oh-my-emby.
8. Images and subtitles use the documented conditional redirect/proxy behavior.
9. One unavailable source degrades results without erasing healthy-source data.
10. Dashboard deep links and `/api/dashboard/*` error routing behave identically on Workers and Docker; missing assets and non-navigation methods never return `index.html`.
11. Logs and Dashboard responses reveal no stored upstream secret or access token.

## Deliberate simplifications

- One user and one virtual server per deployment; use another deployment for another group.
- Exact external IDs only; uncertain matches remain separate.
- Query-driven cache rather than a complete local catalog.
- Version completeness is bounded to eligible sources reached by exact-ID enrichment; the service never claims omniscient catalog completeness.
- Local-first user state with an outbox rather than a distributed transaction.
- 302-only video delivery rather than a media proxy.
- Platform database access is trusted; no misleading at-rest-encryption claim without external key management.
- Approximately ten sources define the initial performance target; increase complexity only after measurement.
