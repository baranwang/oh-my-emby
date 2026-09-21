# Dashboard Demo Full-Stack Alignment Design

Date: 2026-09-22

## Status

Draft for user review.

This specification aligns the approved Dashboard prototype with the production oh-my-emby application. It is an additive revision to:

- [Emby Aggregation Architecture Design](./2026-09-20-emby-aggregation-architecture-design.md)
- [Dashboard Frontend Design](./2026-09-20-dashboard-frontend-design.md)

Where this document conflicts with either parent specification, this document is authoritative for upstream endpoints, User-Agent behavior, external metadata providers, and Dashboard information architecture.

## Intent

The production Dashboard must implement the interaction model already accepted in the static prototype instead of copying only its appearance. The resulting application must let one self-hosting administrator:

- configure an Emby server with multiple ordered connection endpoints;
- choose one of three explicit User-Agent policies;
- configure and order TMDB and Trakt metadata providers;
- manage servers and virtual libraries in route-addressable drawers;
- see operational exceptions without a wall of decorative status cards; and
- deploy the same behavior on Workers/D1 and Docker/Bun/SQLite.

The prototype supplies layout, copy direction, and interaction intent. Its mock data and component-local state are not production inputs.

## Scope

This revision includes contracts, persistence, server-core behavior, Dashboard API handlers, Dashboard UI, migrations, and cross-platform verification for:

1. ordered endpoints per upstream Emby server;
2. fixed, client-preferred, and passthrough User-Agent policies;
3. TMDB and Trakt metadata and artwork enrichment;
4. the approved Overview, Servers, Virtual Libraries, and System layouts; and
5. preservation of current authentication, outbox, runtime status, and deployment behavior.

It does not add fuzzy matching, provider-driven identity changes, video proxying, a media browser, multiple local users, automatic provider discovery, or arbitrary third-party provider plugins.

## Chosen architecture

### Alternatives considered

The implementation uses normalized endpoint and provider records. This adds explicit repository operations but keeps ordering, validation, uniqueness, health, and migration behavior enforceable in both SQLite and D1.

Storing endpoint and provider arrays as JSON was rejected. It would reduce the first migration but move ordering and integrity checks into application code and make endpoint health updates coarse and race-prone.

A Dashboard-only migration was rejected because it would expose controls that the production API and storage model cannot honor.

No generic plugin system is introduced. TMDB and Trakt are the only external providers in this release, and the upstream Emby result is the mandatory final fallback.

## Upstream server model

### Contracts

`ServerInput` replaces `baseUrl` with:

```ts
type ServerEndpointInput = {
  id?: string
  protocol: "http" | "https"
  host: string
  port: number | null
  path: string
}

type UserAgentPolicy = "fixed" | "client-preferred" | "passthrough"

type ServerInput = {
  name: string
  endpoints: ServerEndpointInput[]
  username: string
  password: SecretPatch
  userAgentPolicy: UserAgentPolicy
  userAgent: string | null
  enabled: boolean
}
```

`ServerView` returns ordered endpoints with stable IDs, normalized display URLs, endpoint health, and last-success timestamps. It continues to expose only `hasPassword`; credentials and access tokens never appear in a response.

At least one endpoint is required. Endpoint IDs are server-owned UUIDs. A new input may omit an ID; updates must preserve IDs for unchanged endpoints. Protocol is limited to HTTP and HTTPS. Host excludes credentials, query, fragment, scheme, port, and path. Port is `1..65535` or `null`. Path is normalized to either an empty string or a leading-slash path without query or fragment. Duplicate normalized endpoint URLs within one server are rejected.

The default create form uses HTTP, no explicit port value, a port placeholder of `8096`, and an empty path. The placeholder is presentation only; an omitted port follows the selected protocol's default.

### Persistence and migration

`upstream_servers` retains server identity, credentials, authentication state, generation, enabled state, and aggregate health. URL ownership moves to an `upstream_server_endpoints` table containing:

- endpoint ID and parent server ID;
- normalized protocol, host, optional port, and path;
- stable zero-based order;
- verified catalog ID;
- endpoint health and last-success time; and
- created and updated timestamps.

A forward migration creates the endpoint table and converts every non-deleted `upstream_servers.base_url` into the first endpoint without changing the server ID, catalog namespace, generation, credentials, or source bindings. The migration is idempotent under the repository migration runner. Runtime reads use endpoint records after migration; the legacy column is not a second source of truth.

SQLite and D1 repositories expose the same endpoint operations and ordering guarantees. Endpoint replacement and server updates occur in one repository transaction.

### Catalog identity

All endpoints attached to one server must represent the same upstream Emby catalog. The first successfully verified endpoint establishes the server's `verifiedCatalogId`. Every other endpoint becomes eligible only after it reports that same ID.

An endpoint that is unreachable may be saved but remains unverified and ineligible for normal traffic until a later successful test. An endpoint reporting a different catalog ID is rejected from the server update. If the upstream cannot report a stable identity, an endpoint replacement may retain the catalog namespace only when it is the already verified URL; a new unverifiable endpoint cannot establish equivalence.

Changing endpoint membership or order, username, password, User-Agent policy, User-Agent value, or enabled state increments the server generation. Display-name-only changes do not. A generation change clears authentication state and makes older in-flight results ineligible for persistence.

### Endpoint selection and failover

Eligible endpoints are attempted in configured order. A successful endpoint remains preferred only for that request; this release does not persist dynamic priority or introduce a circuit breaker.

Read-only and idempotent control requests may advance to the next verified endpoint after:

- DNS, connection, TLS, or transport failure;
- the configured request timeout;
- HTTP 500, 502, 503, or 504; or
- a typed endpoint-specific rejection that does not invalidate the shared credentials or catalog identity.

Authentication rejection first performs the existing bounded reauthentication flow. Invalid credentials, an identity mismatch, validation errors, and explicit not-found responses are server-level results and do not trigger endpoint failover.

Non-idempotent upstream writes may use another endpoint only when failure occurred before request transmission is known to have started. Once delivery may have occurred, the request is recorded using the existing uncertain-outbox semantics and is not synchronously replayed on another endpoint.

Aggregate server health is healthy when at least one enabled endpoint is healthy, degraded when no endpoint is healthy but at least one is reachable or previously verified, and unknown when no endpoint has usable evidence. The Dashboard may show per-endpoint state inside the server drawer while cards show aggregate state.

The existing server connection-test operation returns one result per endpoint and the aggregate catalog result. It updates endpoint verification and health without changing endpoint order. A failed test remains a warning and does not prevent saving an intentionally offline server.

## User-Agent policy

One shared upstream-client function resolves the effective User-Agent for every authentication, catalog, metadata, health, image, subtitle, and playback-preparation control request.

The three policies are:

| Policy | Request with inbound client UA | Background request |
| --- | --- | --- |
| `fixed` | configured `userAgent` | configured `userAgent` |
| `client-preferred` | inbound client UA | configured fallback `userAgent`, or product default when empty |
| `passthrough` | inbound client UA | `oh-my-emby/<version>` |

`fixed` requires a non-empty configured value. `client-preferred` accepts an optional fallback. `passthrough` stores no custom value. The server validates these invariants; the form conditionally exposes the value field without weakening server validation.

Only the User-Agent header follows this policy. Other inbound headers remain allowlisted as defined by the parent architecture. Redirect-only video playback remains unchanged: after the initial redirect, the media client sends its own headers and oh-my-emby does not inspect or proxy that request.

## External metadata providers

### Fixed provider set

The default provider order contains two configurable external providers followed by one immutable fallback:

1. TMDB;
2. Trakt; and
3. upstream server metadata.

TMDB and Trakt may be enabled, disabled, configured, and reordered relative to each other. Upstream server metadata is always enabled and always last. The Dashboard does not display separate “metadata” or “images” capability tags because both external providers may supply titles, summaries, posters, and backgrounds.

### Settings contract

The Dashboard API adds:

- `GET /api/dashboard/metadata-settings`; and
- `PUT /api/dashboard/metadata-settings`.

The update is one atomic payload containing the ordered external providers and their configuration. It reuses `SecretPatch` for credential preservation, replacement, and explicit clearing.

The public view contains provider ID, enabled state, order, language where applicable, `hasCredential`, and a secret-safe status of `unconfigured`, `ready`, or `degraded`. It never returns a TMDB token or Trakt client ID.

TMDB configuration contains an API Read Access Token and language. Trakt configuration contains a Client ID. The upstream fallback has no editable credential because it uses the configured Emby servers.

### Persistence

`metadata_provider_settings` stores the fixed external provider IDs, enabled state, order, optional language, credential, and timestamps. A database constraint prevents duplicate order values. Provider settings are initialized lazily to disabled TMDB and disabled Trakt rows when absent; upstream fallback is implicit and is not stored as a mutable row.

`external_metadata_cache` stores provider ID, typed external identity, normalized payload, positive or negative result, fetched time, fresh-until time, and stale-until time. Credentials never enter cache keys, payloads, logs, or browser responses.

Provider-setting changes invalidate affected external-provider cache entries. They do not delete canonical identities, source mappings, user state, or query generations already published.

### Fetch and merge behavior

External providers are queried only when an item has the exact provider ID needed by that provider. IMDb-to-provider lookup may use an exact external-ID endpoint. No provider request uses title, year, runtime, or fuzzy search to establish identity.

Enrichment occurs during detail hydration and other existing bounded exact-ID hydration paths. List federation does not fan out an external request per row. Positive and negative results use bounded cache lifetimes so repeated detail requests do not repeatedly call providers.

Fields are merged in configured provider order using first-non-empty-value wins. A lower-priority provider fills missing fields but never overwrites a present higher-priority field. Upstream server metadata is the final source. External metadata cannot add, remove, merge, split, or replace canonical identity claims.

TMDB and Trakt normalized payloads may supply:

- title or name;
- overview or summary;
- poster image reference; and
- backdrop or fanart image reference.

Provider failures are classified and observed per provider. A timeout, rate limit, unavailable credential, or malformed provider response does not make otherwise valid upstream metadata fail. The service continues to the next provider and reports degraded provider status to the Dashboard without exposing secret material.

### Image delivery

External image references are registered as bounded server-owned resources and served through the existing Emby image surface. Clients never receive provider credentials or an administrator-supplied arbitrary proxy URL.

The resource layer applies the parent architecture's scheme, destination, redirect, size, cache, and SSRF rules. It may redirect to a validated public provider CDN or proxy/cache the image when direct client access is not viable. This does not change the prohibition on video proxying.

## Dashboard information architecture

### Shared shell

The authenticated navigation remains Overview, Servers, Virtual Libraries, and System. The user entry moves to the Sidebar footer and opens a shadcn menu containing the current username, password change, and logout. Language and appearance controls move from the global header to System settings.

The top-of-content control strip currently holding language, theme, and logout is removed. The responsive Sidebar, breadcrumb semantics, keyboard order, focus treatment, and mobile navigation remain.

### Overview

Overview is an action surface, not a metric wall. It uses real Query data to show only:

- unhealthy or unverified servers;
- failed or uncertain state synchronization;
- virtual libraries that have no usable sources; and
- the next setup action when servers or libraries are absent.

When there are no exceptions, the page shows a compact healthy state and direct links to Servers and Virtual Libraries. Decorative cards with no action or diagnostic value are omitted.

### Servers

The page title is “Servers” / “服务器”; “Provider” is not used for Emby server records. The list uses the approved server-card composition and aggregate health. Add and edit open the approved right-side inset shadcn Drawer. The drawer is not flush with the viewport edge and does not render a swipe handle.

The base route `/dashboard/servers` renders the list with no drawer. `/dashboard/servers/$id` renders the same list with the selected server drawer open. Create state is represented by validated route search on `/dashboard/servers`, allowing refresh and browser history without inventing a persisted ID.

The form contains:

- display name and enabled state;
- an ordered list of one or more endpoint rows;
- username and write-only password controls; and
- the three User-Agent choices rendered with shadcn `RadioGroup`, `Field`, `FieldContent`, `FieldTitle`, and `FieldDescription`.

Each endpoint is one readable row rather than one visually undifferentiated input. Protocol, host, port, and path use shadcn Input Group composition where it remains legible; narrow layouts wrap into labeled controls. Add, remove, and reorder actions use accessible labels. The port placeholder is `8096`.

### Virtual Libraries

Virtual-library add and edit use the same list-plus-inset-drawer pattern. `/dashboard/libraries/$id` controls the edit drawer, and validated search controls create state. Existing media-type, source selection, enabled state, stable IDs, and deep links remain authoritative.

### System

System uses lightweight sections separated by shadcn Separator rather than large nested cards. Its order is:

1. metadata providers;
2. client endpoint;
3. runtime and database status;
4. preferences; and
5. advanced account or diagnostic actions.

Each metadata-provider row shows the provider name with “Configured” / “Not configured” and enabled state beside it, a right-aligned Settings/Edit action, then ordering controls at the far end. TMDB and Trakt open provider-specific drawers. Upstream Server is shown as the fixed final fallback and has no reorder or credential action.

Outbox details remain available but are collapsed behind the synchronization-status row and become prominent only when failed or uncertain entries exist. Runtime counters remain accessible without dominating the page. The client endpoint is copyable and derived from the configured public origin.

TMDB settings expose Read Access Token and language. Trakt settings expose Client ID. Language and appearance use shadcn Select controls in Preferences.

### Data and component rules

TanStack Query owns all server state, including overview summaries and metadata settings. TanStack Router owns drawer URL state. TanStack Form owns editable drafts and uses the shared Effect schemas. No production feature reads the prototype's mock state.

All newly required shadcn primitives are installed with the repository's Bun-based shadcn CLI and existing preset. The implementation may install only components actually used, expected to include Badge, Card, Drawer, Dropdown Menu, Field, Input Group, Radio Group, Scroll Area, Select, Separator, Switch, and Button Group. It must not hand-write replacements or override generated component styling to imitate another shadcn version.

The approved preset tokens, fonts, radii, semantic colors, and light/dark behavior remain the visual source of truth. Natural-language copy and accessible labels exist in both Paraglide locales with parity tests.

## API and query ownership

`packages/contracts` remains the only public DTO definition. The Dashboard API adds metadata settings and extends server DTOs; it does not add parallel handwritten browser types.

Dashboard query keys add `metadataSettings`. Existing keys remain stable. Route loaders fetch only authentication prerequisites and selected detail records; list and drawer components consume the same Query options so duplicate requests are deduplicated.

Mutations invalidate the narrowest affected keys:

- server changes invalidate server list, selected server, endpoint health, eligible source libraries, system status, and overview state;
- library changes invalidate library list, selected library, and overview state; and
- metadata setting changes invalidate metadata settings and provider status, but not canonical identity or local user state.

No optimistic configuration writes are introduced.

## Error handling

Server forms preserve unsaved values when a connection test, save, or provider call fails. Field validation errors attach to their controls; identity mismatch and endpoint-specific failures identify the affected endpoint row. Saving an intentionally offline endpoint remains allowed, but unverified endpoints are clearly ineligible.

Provider settings distinguish missing credentials, disabled state, rejected credentials, timeout/rate limit, and provider outage. The client sees typed, secret-safe errors. External-provider failure never suppresses usable upstream metadata.

Drawer close after a successful save returns to the collection URL. Failed saves keep the drawer and focus the error summary or first invalid control. Direct navigation to a missing server or library ID shows the existing typed not-found state and offers a return to the collection.

## Deployment parity

The feature uses no Node-only production APIs. HTTP clients, clocks, version strings, repositories, cache, and provider settings remain Effect services constructed by the Workers or Bun platform layer.

Workers use D1 and Workers Fetch. Docker uses Bun SQLite and Bun HTTP. Both execute the same migrations and shared core behavior. Provider credentials remain within the trusted deployment database boundary described by the parent architecture; this revision does not claim application-layer encryption without a separately managed key.

## Verification requirements

Implementation is not complete until fresh checks cover:

- Effect schema acceptance and rejection for endpoint structure and all three UA policies;
- preservation of `SecretPatch` semantics and response redaction;
- migration of every legacy `base_url` into ordered endpoint records;
- SQLite/D1 repository parity for endpoint ordering and provider settings;
- same-catalog endpoint verification and different-catalog rejection;
- safe read failover order and uncertain-write non-replay;
- effective UA resolution for client and background requests;
- provider priority, first-non-empty merge, positive cache, and negative cache;
- TMDB and Trakt poster/backdrop normalization and image resource delivery;
- provider degradation falling back to upstream metadata;
- server and virtual-library drawer deep links, close navigation, and responsive layout;
- System provider ordering, configuration status, preferences, and conditional outbox disclosure;
- Paraglide English/Simplified Chinese key parity;
- the existing cross-platform contract suite on Bun and the Workers harness; and
- one bounded browser QA pass at desktop and mobile widths, followed by at most one confirmation pass.

No check may claim real SenPlayer behavior or remote Cloudflare deployment unless that environment is actually exercised.

## Acceptance criteria

The revision is accepted when an administrator can configure multiple endpoints for one verified Emby catalog, select and observe the declared UA behavior, configure and reorder TMDB and Trakt, and use the prototype-aligned Dashboard without losing any existing production capability.

Equivalent requests produce the same domain results on Workers/D1 and Docker/Bun/SQLite. Existing single-address records survive migration. Secrets remain write-only. External metadata enriches presentation but never changes canonical identity. Video playback remains redirect-only.
