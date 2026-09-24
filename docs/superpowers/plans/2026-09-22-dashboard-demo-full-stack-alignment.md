# Dashboard Demo Full-Stack Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production application implement the approved Dashboard prototype together with ordered Emby endpoints, three User-Agent policies, and TMDB/Trakt metadata and artwork enrichment.

**Architecture:** Extend the shared Effect contracts first, then normalize endpoint/provider persistence in both repositories, route all upstream traffic through one failover/UA decision point, and add a small external-metadata service consumed by federation and image resolution. The React SPA keeps TanStack Query/Form/Router ownership and replaces separate edit pages with URL-controlled shadcn Drawers using the prototype only as visual evidence.

**Tech Stack:** Bun 1.4.2, TypeScript 7, Effect 4.0.0-rc.112, Workers/D1, Bun/SQLite, React 19, TanStack Query/Router/Form, shadcn base-nova, Paraglide, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-dashboard-demo-full-stack-alignment-design.md`

## Global Constraints

- Bun is the sole package manager and script runner; commit only `bun.lock`.
- Workers/D1 and Docker/Bun/SQLite must expose the same contracts and domain behavior.
- Video playback remains redirect-only; never proxy, transcode, or inspect the post-redirect media request.
- External providers may enrich presentation only; they never create or alter canonical identity claims.
- Credentials and provider keys are write-only, redacted from logs, and returned only as `hasCredential`.
- All new UI primitives must be installed with `bunx --bun shadcn@latest add`; do not hand-write shadcn substitutes.
- Preserve the checked-in preset tokens and generated component styling; `.oxlintrc.json` with `@shadcn/lint` remains binding.
- TanStack Query owns server state, TanStack Router owns drawer URL state, and TanStack Form owns editable drafts.
- All visible copy and ARIA labels must exist in both `messages/en.json` and `messages/zh-CN.json`.
- The ignored `.design/dashboard-prototype` is a visual reference only; never import its mock state into production.
- Do not claim real SenPlayer or remote Cloudflare validation unless those environments are actually exercised.

## Review Focus

- Endpoint normalization must reject duplicate URLs even when default ports, trailing slashes, or path spelling differ; Task 1 and Task 2 pin this.
- A server with mixed verified, unreachable, and mismatched endpoints must never send traffic to the mismatched endpoint; Task 3 pins this.
- A timed-out upstream write must become uncertain and must not replay on another endpoint; Task 3 pins this.
- Sparse, negative, rate-limited, or malformed provider responses must fall back without erasing upstream fields; Task 5 pins this.
- Direct drawer deep links, refresh, close navigation, mobile layout, and expired sessions must preserve router/auth behavior; Tasks 7–9 pin this.

---

### Task 1: Shared contracts for endpoints, UA policy, and metadata settings

**Files:**

- Modify: `packages/contracts/src/schemas.ts`
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/dashboard.test.ts`

**Interfaces:**

- Produces: `ServerEndpointInput`, `ServerEndpointView`, `UserAgentPolicy`, revised `ServerInput`, revised `ServerView`, revised `ConnectionTestView`, `MetadataProviderSettingsInput`, and `MetadataProviderSettingsView`.
- Produces: Dashboard API methods `getMetadataSettings` and `updateMetadataSettings` under the `system` group.

- [ ] **Step 1: Write failing schema tests**

Add table-driven tests proving HTTP/HTTPS-only endpoints, port range `1..65535`, normalized path requirements, non-empty endpoint arrays, and these UA invariants:

```ts
const fixed = { userAgentPolicy: "fixed", userAgent: "SenPlayer/3.2.1" };
const preferred = { userAgentPolicy: "client-preferred", userAgent: null };
const passthrough = { userAgentPolicy: "passthrough", userAgent: null };

await expect(
  Schema.decodeUnknownPromise(ServerInput)({ ...base, endpoints: [] }),
).rejects.toBeDefined();
await expect(
  Schema.decodeUnknownPromise(ServerInput)({ ...base, ...fixed }),
).resolves.toBeDefined();
await expect(
  Schema.decodeUnknownPromise(ServerInput)({ ...base, ...preferred }),
).resolves.toBeDefined();
await expect(
  Schema.decodeUnknownPromise(ServerInput)({ ...base, ...passthrough }),
).resolves.toBeDefined();
await expect(
  Schema.decodeUnknownPromise(ServerInput)({
    ...base,
    userAgentPolicy: "fixed",
    userAgent: null,
  }),
).rejects.toBeDefined();
```

Test provider ordering with exactly one `tmdb` and one `trakt`, and assert encoded views contain `hasCredential` but no credential value.

- [ ] **Step 2: Run the contract test and verify failure**

Run: `cd packages/contracts && bun --bun vitest run test/dashboard.test.ts`

Expected: FAIL because the new schemas and API methods do not exist.

- [ ] **Step 3: Implement the schemas and API group**

Use these exact discriminants and fields:

```ts
export const UserAgentPolicy = Schema.Literals(["fixed", "client-preferred", "passthrough"]);
export const MetadataProviderId = Schema.Literals(["tmdb", "trakt"]);
export const MetadataProviderStatus = Schema.Literals(["unconfigured", "ready", "degraded"]);

export const ServerEndpointInput = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyString),
  protocol: Schema.Literals(["http", "https"]),
  host: Schema.NonEmptyString,
  port: Schema.NullOr(Schema.Int),
  path: Schema.String,
});
```

Implement the UA cross-field rule with one schema filter/refinement. `MetadataProviderSettingsInput` is an ordered two-element array of provider entries with `credential: SecretPatch`; the view uses `hasCredential` and `status` instead. Extend `ConnectionTestView` with ordered per-endpoint `{ endpointId, reachable, catalogId, health }` results and one aggregate `catalogId`.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `cd packages/contracts && bun --bun vitest run test/dashboard.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: define endpoint and metadata contracts"
```

### Task 2: Cross-platform endpoint and metadata persistence

**Files:**

- Modify: `apps/server/migrations/0001_initial.sql`
- Create: `apps/server/migrations/0002_dashboard_alignment.sql`
- Modify: `apps/server/src/core/model.ts`
- Modify: `apps/server/src/core/repositories.ts`
- Modify: `apps/server/src/platform/bun/sqlite-repositories.ts`
- Modify: `apps/server/src/platform/workers/d1-repositories.ts`
- Modify: `apps/server/test/repository-contract.ts`
- Modify: `apps/server/test/sqlite-repository.test.ts`
- Modify: `apps/server/test/d1-repository.test.ts`
- Modify: `apps/server/test/cross-platform-contract.ts`

**Interfaces:**

- Consumes: Task 1 contract types.
- Produces: `UpstreamEndpoint`, endpoint-bearing `UpstreamServer`/`EligibleSource`, `MetadataProviderSetting`, and `ExternalMetadataCacheEntry`.
- Produces repository methods `readMetadataSettings`, `writeMetadataSettings`, `readExternalMetadata`, and `writeExternalMetadata` plus transactional endpoint-aware server writes.

- [ ] **Step 1: Write failing repository and migration tests**

Add a legacy-schema fixture with one `upstream_servers.base_url`, apply `0002_dashboard_alignment.sql`, then assert one order-zero endpoint with the same server ID and URL parts. Extend the shared repository contract to create, read, reorder, and delete endpoints atomically and round-trip provider settings without returning credentials through views.

```ts
expect(
  server.endpoints.map(({ protocol, host, port, path }) => ({ protocol, host, port, path })),
).toEqual([
  { protocol: "https", host: "emby.example.com", port: 8443, path: "/emby" },
  { protocol: "http", host: "192.168.1.10", port: 8096, path: "" },
]);
```

- [ ] **Step 2: Run focused repository tests and verify failure**

Run: `cd apps/server && bun --bun vitest run test/sqlite-repository.test.ts`

Expected: FAIL because endpoint/provider tables and repository methods do not exist.

- [ ] **Step 3: Add schema and migration**

Fresh schema and forward migration must converge on these tables:

```sql
CREATE TABLE upstream_server_endpoints (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'https')),
  host TEXT NOT NULL,
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  path TEXT NOT NULL,
  endpoint_order INTEGER NOT NULL CHECK (endpoint_order >= 0),
  verified_catalog_id TEXT,
  health TEXT NOT NULL CHECK (health IN ('unknown', 'healthy', 'degraded')),
  last_success_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (server_id, endpoint_order),
  UNIQUE (server_id, protocol, host, port, path)
) STRICT;

CREATE TABLE metadata_provider_settings (
  provider_id TEXT PRIMARY KEY CHECK (provider_id IN ('tmdb', 'trakt')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  provider_order INTEGER NOT NULL UNIQUE CHECK (provider_order IN (0, 1)),
  language TEXT,
  credential TEXT,
  status TEXT NOT NULL CHECK (status IN ('unconfigured', 'ready', 'degraded')),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE external_metadata_cache (
  provider_id TEXT NOT NULL CHECK (provider_id IN ('tmdb', 'trakt')),
  identity_namespace TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  found INTEGER NOT NULL CHECK (found IN (0, 1)),
  fetched_at_ms INTEGER NOT NULL,
  fresh_until_ms INTEGER NOT NULL,
  stale_until_ms INTEGER NOT NULL,
  PRIMARY KEY (provider_id, identity_namespace, identity_value)
) STRICT;
```

Keep legacy `base_url` and `user_agent` columns as write-only compatibility mirrors for upgraded databases; runtime selection reads normalized endpoint rows and `user_agent_policy`.

- [ ] **Step 4: Implement both repository adapters**

Make create/update server transactions replace endpoint rows and server configuration together under the existing generation fence. Map empty legacy `user_agent` to contract `null`. Seed absent metadata settings as disabled TMDB order 0 and disabled Trakt order 1 without creating an upstream row.

- [ ] **Step 5: Run SQLite, D1, and migration parity tests**

Run: `cd apps/server && bun --bun vitest run test/sqlite-repository.test.ts test/cross-platform.test.ts`

Run: `cd apps/server && bun run test:workers -- test/d1-repository.test.ts`

Expected: PASS with the same endpoint ordering and provider values in both adapters.

- [ ] **Step 6: Commit**

```bash
git add apps/server/migrations apps/server/src/core/model.ts apps/server/src/core/repositories.ts apps/server/src/platform apps/server/test
git commit -m "feat: persist ordered endpoints and metadata settings"
```

### Task 3: Centralized endpoint failover and User-Agent resolution

**Files:**

- Modify: `apps/server/src/core/upstream-client.ts`
- Modify: `apps/server/src/core/server-service.ts`
- Modify: `apps/server/src/core/federation.ts`
- Modify: `apps/server/src/core/playback.ts`
- Modify: `apps/server/src/core/outbox.ts`
- Modify: `apps/server/src/api/emby.ts`
- Modify: `apps/server/test/upstream-client.test.ts`
- Modify: `apps/server/test/server-service.test.ts`
- Modify: `apps/server/test/outbox.test.ts`
- Modify: `apps/server/test/playback.test.ts`

**Interfaces:**

- Consumes: endpoint-bearing server records from Task 2.
- Produces: `effectiveUserAgent(server, clientUserAgent)` and `endpointUrl(endpoint)` pure helpers.
- Produces: `UpstreamRequest.clientUserAgent?: string`; request callers pass the inbound Emby UA, while maintenance/outbox omit it.

- [ ] **Step 1: Write failing UA, failover, identity, and uncertainty tests**

Cover the exact policy matrix:

```ts
expect(effectiveUserAgent(fixedServer, "Client/1")).toBe("Configured/1");
expect(effectiveUserAgent(preferredServer, "Client/1")).toBe("Client/1");
expect(effectiveUserAgent(preferredServer, undefined)).toBe("Fallback/1");
expect(effectiveUserAgent(passthroughServer, "Client/1")).toBe("Client/1");
expect(effectiveUserAgent(passthroughServer, undefined)).toBe("oh-my-emby/0.0.0");
```

Use a deterministic fake fetch to prove GET failover order on transport failure and 503, no failover on 401/404/catalog mismatch, and no second endpoint call after a POST timeout. Assert connection testing marks only same-catalog endpoints eligible and returns ordered endpoint results.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd apps/server && bun --bun vitest run test/upstream-client.test.ts test/server-service.test.ts test/outbox.test.ts test/playback.test.ts`

Expected: FAIL on missing helpers and endpoint-aware behavior.

- [ ] **Step 3: Implement one upstream selection path**

Build URLs only with `endpointUrl`. Advance to another verified endpoint only for GET requests after transport/timeout/500/502/503/504. `replaySafe` may still authorize the existing bounded 401 reauthentication replay on the same endpoint, but it never authorizes a POST to move to another endpoint. Keep the original request generation fence across attempts.

Propagate `request.headers.get("user-agent") ?? undefined` from `makeEmbyHandler` through federated query/detail/playback inputs to `UpstreamRequest.clientUserAgent`. Background maintenance and outbox calls omit it.

- [ ] **Step 4: Update server configuration and connection testing**

Normalize/deduplicate endpoints before persistence, preserve stable endpoint IDs, increment generation for endpoint membership/order or UA changes, and clear auth state on generation change. Test every endpoint, reject a reported catalog mismatch, allow unreachable endpoints to remain saved but ineligible, and compute aggregate health from endpoint rows.

- [ ] **Step 5: Run focused tests and server typecheck**

Run: `cd apps/server && bun --bun vitest run test/upstream-client.test.ts test/server-service.test.ts test/outbox.test.ts test/playback.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/core apps/server/src/api/emby.ts apps/server/test
git commit -m "feat: add endpoint failover and UA policies"
```

### Task 4: Metadata settings service and Dashboard API

**Files:**

- Create: `apps/server/src/core/metadata-settings.ts`
- Modify: `apps/server/src/api/dashboard.ts`
- Modify: `apps/server/src/platform/bun/index.ts`
- Modify: `apps/server/src/platform/workers/index.ts`
- Create: `apps/server/test/metadata-settings.test.ts`
- Modify: `apps/server/test/dashboard-auth.test.ts`

**Interfaces:**

- Consumes: Task 1 metadata contracts and Task 2 repository methods.
- Produces: `MetadataSettings` Effect service with `get()` and `update(input)`.

- [ ] **Step 1: Write failing service and API tests**

Assert default order TMDB then Trakt, atomic reorder, `Preserve`/`Set`/`Clear`, disabled-with-credential retention, `hasCredential` redaction, and same-origin/auth enforcement on both new endpoints.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd apps/server && bun --bun vitest run test/metadata-settings.test.ts test/dashboard-auth.test.ts`

Expected: FAIL because the service and handlers do not exist.

- [ ] **Step 3: Implement the service**

Use one update transaction for both providers. Reject duplicate/missing provider IDs and duplicate order. Apply credentials with the existing `SecretPatch` semantics:

```ts
const applySecret = (current: string | null, patch: SecretPatch): string | null => {
  switch (patch._tag) {
    case "Preserve":
      return current;
    case "Set":
      return patch.value;
    case "Clear":
      return null;
  }
};
```

Status is `unconfigured` when enabled without a credential, `ready` after a valid saved credential until a provider failure is recorded, and `degraded` after a typed provider failure.

- [ ] **Step 4: Wire authenticated Dashboard handlers and runtime layers**

Add `getMetadataSettings` and `updateMetadataSettings` to the existing system handler group and provide the service in both Bun and Workers core layers. Reuse existing origin/session guards and `publicFailure` mapping.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd apps/server && bun --bun vitest run test/metadata-settings.test.ts test/dashboard-auth.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/core/metadata-settings.ts apps/server/src/api/dashboard.ts apps/server/src/platform apps/server/test
git commit -m "feat: expose metadata provider settings"
```

### Task 5: TMDB/Trakt enrichment and external artwork delivery

**Files:**

- Create: `apps/server/src/core/metadata-providers.ts`
- Modify: `apps/server/src/core/federation.ts`
- Modify: `apps/server/src/core/playback.ts`
- Modify: `apps/server/src/platform/bun/index.ts`
- Modify: `apps/server/src/platform/workers/index.ts`
- Create: `apps/server/test/metadata-providers.test.ts`
- Modify: `apps/server/test/federation.test.ts`
- Modify: `apps/server/test/resources.test.ts`

**Interfaces:**

- Consumes: provider settings/cache from Tasks 2 and 4.
- Produces: `MetadataProviders` service with `refresh(record)`, `overlayCached(record)`, and `resolveCachedImage(record, imageType, imageIndex)`.
- Produces normalized payload `{ Name?, Overview?, ExternalImages?: { Primary?: string; Backdrop?: string[] } }`.

- [ ] **Step 1: Write failing adapter, merge, cache, and image tests**

Test TMDB Bearer auth and `/3/find/{imdb}?external_source=imdb_id&language=...`; test Trakt `/movies/{id}?extended=full` and `/shows/{id}?extended=full` with `trakt-api-key` and `trakt-api-version: 2`. Pin title/summary/poster/fanart normalization, first-non-empty merge by configured order, positive and negative cache, timeout/rate-limit fallback, malformed image rejection, and upstream final fallback.

Assert only `https://image.tmdb.org/...` and normalized `https://walter-r2.trakt.tv/...` artwork is accepted. A requested Primary or Backdrop image must resolve through the existing `/Items/:id/Images/:type/:index?` route as a validated redirect; arbitrary response hosts are rejected and fall back upstream.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd apps/server && bun --bun vitest run test/metadata-providers.test.ts test/federation.test.ts test/resources.test.ts`

Expected: FAIL because external metadata service does not exist.

- [ ] **Step 3: Implement provider adapters without dependencies**

Use the injected platform `fetch`; do not add an SDK. TMDB uses `Authorization: Bearer <token>`. Trakt uses `trakt-api-key`, `trakt-api-version: 2`, JSON accept/content type, and product User-Agent. Bound response size, timeout, JSON decoding, and cache lifetime with the existing Effect/error patterns.

TMDB image URLs use the secure configuration base with `w780` for posters and `w1280` for backdrops. Trakt scheme-less documented image values are normalized to HTTPS only when the host is exactly `walter-r2.trakt.tv`.

- [ ] **Step 4: Integrate cache-only list overlay and detail refresh**

List/search results call `overlayCached` only and never fan out per row. Detail hydration calls `refresh`, merges configured external providers before upstream fields, and returns the overlay without mutating identity claims or source metadata. Failed providers update secret-safe status and continue.

- [ ] **Step 5: Integrate image resolution**

`Playback.resolveImage` checks cached external artwork before upstream image versions. Return the existing `ResourceDecision.Redirect` for allowlisted public HTTPS provider images; retain current upstream proxy/cache behavior as fallback.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/server && bun --bun vitest run test/metadata-providers.test.ts test/federation.test.ts test/resources.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/core/metadata-providers.ts apps/server/src/core/federation.ts apps/server/src/core/playback.ts apps/server/src/platform apps/server/test
git commit -m "feat: enrich metadata with TMDB and Trakt"
```

### Task 6: Production shadcn foundation, shell, and actionable Overview

**Files:**

- Modify through CLI: `apps/dashboard/src/components/ui/*`
- Modify: `apps/dashboard/src/components/app-shell/app-shell.tsx`
- Create: `apps/dashboard/src/modules/overview/overview-page.tsx`
- Modify: `apps/dashboard/src/routes/_authenticated/index.tsx`
- Modify: `apps/dashboard/messages/en.json`
- Modify: `apps/dashboard/messages/zh-CN.json`
- Modify: `apps/dashboard/test/page-states.test.tsx`
- Modify: `apps/dashboard/test/i18n.test.ts`

**Interfaces:**

- Consumes: existing servers, libraries, system, outbox Query options.
- Produces: shared generated primitives and `OverviewPage` derived only from Query data.

- [ ] **Step 1: Install only the required shadcn primitives**

Run:

```bash
cd apps/dashboard
bunx --bun shadcn@latest add badge button-group card drawer dropdown-menu field input-group radio-group scroll-area select separator switch
```

Do not copy files from `.design`; the CLI output is authoritative.

- [ ] **Step 2: Write failing shell/overview tests**

Assert language/theme controls are absent from the header, the Sidebar footer exposes the username menu, and Overview renders setup actions for empty data, exception links for degraded data, and one compact healthy state without decorative metric cards.

- [ ] **Step 3: Implement shell and Overview**

Move password change/logout into the Sidebar footer dropdown; keep the password form in an accessible drawer or dialog opened from that menu. Remove header language/theme selects. Compose Overview from `serversQueryOptions`, `librariesQueryOptions`, `systemQueryOptions`, and `outboxFailuresQueryOptions`; do not add an overview endpoint or duplicate state.

- [ ] **Step 4: Add locale copy and run Dashboard checks**

Run: `cd apps/dashboard && bun --bun vitest run test/page-states.test.tsx test/i18n.test.ts && bun run typecheck`

Expected: PASS and equal locale key sets.

- [ ] **Step 5: Run shadcn lint**

Run: `bunx oxlint apps/dashboard/src`

Expected: PASS with `shadcn/no-restyle` enabled.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard bun.lock
git commit -m "feat: align dashboard shell and overview"
```

### Task 7: Server cards and route-controlled editor Drawer

**Files:**

- Modify: `apps/dashboard/src/modules/servers/components/server-list.tsx`
- Modify: `apps/dashboard/src/modules/servers/components/server-form.tsx`
- Modify: `apps/dashboard/src/modules/servers/components/server-detail.tsx`
- Modify: `apps/dashboard/src/modules/servers/servers-page.tsx`
- Modify: `apps/dashboard/src/modules/servers/hooks/use-servers.ts`
- Modify: `apps/dashboard/src/modules/servers/services/server-service.ts`
- Modify: `apps/dashboard/src/routes/_authenticated/servers.index.tsx`
- Modify: `apps/dashboard/src/routes/_authenticated/servers.$id.tsx`
- Modify: `apps/dashboard/messages/en.json`
- Modify: `apps/dashboard/messages/zh-CN.json`
- Modify: `apps/dashboard/test/server-form.test.tsx`
- Modify: `apps/dashboard/test/query-behavior.test.tsx`
- Create: `apps/dashboard/test/server-drawer.test.tsx`

**Interfaces:**

- Consumes: Task 1 server contracts and Task 6 generated primitives.
- Produces: one list page that owns create/edit Drawer state through route search and `$id`.

- [ ] **Step 1: Write failing form and routing tests**

Assert default endpoint `{ protocol: "http", host: "", port: null, path: "" }`, visible port placeholder `8096`, add/remove/reorder behavior, all three UA choice cards, conditional UA input, SecretPatch preservation, and endpoint-specific validation.

Assert `/servers?new=true` opens create, `/servers/$id` opens edit over the same list, close returns to `/servers`, refresh preserves the drawer, missing IDs render typed failure, and successful save closes while failed save retains values.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd apps/dashboard && bun --bun vitest run test/server-form.test.tsx test/server-drawer.test.tsx test/query-behavior.test.tsx`

Expected: FAIL against the old single-URL form and detail page.

- [ ] **Step 3: Implement prototype-aligned cards and Drawer**

Use generated `Card` without restyling its structural border, and keep the add-server control the same card height as server cards. Use right-side inset `DrawerContent` with no swipe handle. The page heading is “Servers” / “服务器”.

Render each endpoint as a readable Input Group with Select protocol, host input, optional port input, and path input; wrap into labeled controls on narrow screens. Use `Field` choice cards plus `RadioGroup` for UA policy. Keep the manual connection test as a separate diagnostic action and render ordered per-endpoint results. Saving an enabled server also automatically tests its connections and fetches source libraries; retain saved configuration and show a footer error if discovery fails, with retries updating the saved server rather than creating a duplicate.

- [ ] **Step 4: Update Query mutations and narrow invalidation**

Server saves invalidate `servers`, selected `server(id)`, health, source libraries, `system`, and Overview's existing constituent keys. Do not create a separate client store.

- [ ] **Step 5: Run tests, typecheck, and lint**

Run: `cd apps/dashboard && bun --bun vitest run test/server-form.test.tsx test/server-drawer.test.tsx test/query-behavior.test.tsx && bun run typecheck`

Run: `bunx oxlint apps/dashboard/src`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard
git commit -m "feat: add server drawer and multi-line editor"
```

### Task 8: Virtual-library Drawer and lightweight System settings

**Files:**

- Modify: `apps/dashboard/src/modules/libraries/components/library-list.tsx`
- Modify: `apps/dashboard/src/modules/libraries/components/library-form.tsx`
- Modify: `apps/dashboard/src/modules/libraries/components/library-detail.tsx`
- Modify: `apps/dashboard/src/modules/libraries/libraries-page.tsx`
- Modify: `apps/dashboard/src/routes/_authenticated/libraries.index.tsx`
- Modify: `apps/dashboard/src/routes/_authenticated/libraries.$id.tsx`
- Create: `apps/dashboard/src/modules/system/components/metadata-providers.tsx`
- Create: `apps/dashboard/src/modules/system/components/metadata-provider-editor.tsx`
- Create: `apps/dashboard/src/modules/system/components/preferences.tsx`
- Modify: `apps/dashboard/src/modules/system/system-page.tsx`
- Modify: `apps/dashboard/src/modules/system/hooks/use-system.ts`
- Modify: `apps/dashboard/src/modules/system/services/system-service.ts`
- Modify: `apps/dashboard/src/lib/query-keys.ts`
- Modify: `apps/dashboard/messages/en.json`
- Modify: `apps/dashboard/messages/zh-CN.json`
- Create: `apps/dashboard/test/library-drawer.test.tsx`
- Create: `apps/dashboard/test/system-settings.test.tsx`

**Interfaces:**

- Consumes: metadata Dashboard API from Task 4 and primitives from Task 6.
- Produces: `metadataSettingsQueryOptions`, update mutation, provider editor drawers, preferences section, and list-backed library editor Drawer.

- [ ] **Step 1: Write failing library and System tests**

Pin library create/edit/close/deep-link behavior to the same rules as Task 7. For System, assert section order: metadata providers, client endpoint, runtime/database, preferences, advanced diagnostics. Assert configured/unconfigured status beside names, settings action on the right, reorder controls at the far end, immutable upstream fallback last, and no meaningless “metadata/image” tags.

Assert TMDB drawer fields are Read Access Token and language; Trakt drawer field is Client ID. Assert language/theme move here and outbox detail is collapsed unless failed/uncertain counts are nonzero.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd apps/dashboard && bun --bun vitest run test/library-drawer.test.tsx test/system-settings.test.tsx`

Expected: FAIL against independent detail pages and old heavy System sections.

- [ ] **Step 3: Implement the virtual-library Drawer**

Keep existing TanStack Form source selection and media-type validation, but host create/edit in the list page's inset Drawer. Route search controls create; `$id` controls edit. Preserve typed loading/error/empty states and the add-server escape hatch.

- [ ] **Step 4: Implement metadata and preference settings**

Add `queryKeys.metadataSettings`, generated-client service calls, Query hooks, provider reorder mutation, and provider-specific TanStack Forms using `SecretPatch`. Build System with Separator rows instead of Card containers. Derive the copyable client endpoint from `globalThis.location.origin`. Keep runtime counters and outbox diagnostics available without leading the page.

- [ ] **Step 5: Run tests, locale parity, typecheck, and lint**

Run: `cd apps/dashboard && bun --bun vitest run test/library-drawer.test.tsx test/system-settings.test.tsx test/i18n.test.ts && bun run typecheck`

Run: `bunx oxlint apps/dashboard/src`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard
git commit -m "feat: align library and system interactions"
```

### Task 9: Cross-platform acceptance and bounded visual QA

**Files:**

- Modify: `apps/server/test/cross-platform-contract.ts`
- Modify: `apps/server/test/cross-platform.test.ts`
- Modify: `apps/server/test/workers-routing.test.ts`
- Modify: `apps/dashboard/test/page-states.test.tsx`
- Modify if defects are found: files touched by Tasks 1–8 only

**Interfaces:**

- Consumes: all prior task interfaces.
- Produces: one cross-runtime acceptance scenario and final browser evidence for the approved desktop/mobile surfaces.

- [ ] **Step 1: Extend the cross-platform contract before fixes**

Run one shared scenario on Bun/SQLite and Workers/D1 that creates a two-endpoint server, observes fixed/client-preferred/passthrough UA behavior, saves/reorders provider settings, exercises provider fallback, and reads secret-safe Dashboard views. Compare domain responses rather than runtime-specific storage details.

- [ ] **Step 2: Run the full automated suite**

Run: `bun run check`

Run: `cd apps/server && bun run test:workers`

Expected: PASS. Fix only regressions caused by this plan and rerun the smallest covering test before repeating the full commands once.

- [ ] **Step 3: Run the Impeccable detector once**

Run:

```bash
/Users/baran/.codex/plugins/cache/impeccable/impeccable/4.3.1/skills/impeccable/scripts/impeccable detect --json \
  apps/dashboard/src/components/app-shell \
  apps/dashboard/src/modules/overview \
  apps/dashboard/src/modules/servers \
  apps/dashboard/src/modules/libraries \
  apps/dashboard/src/modules/system
```

Resolve actionable detector failures in one batch. Do not rerun the detector.

- [ ] **Step 4: Perform one desktop/mobile browser pass**

Start the Bun server and Vite Dashboard, then use the browser automation skill to verify `/dashboard/`, `/dashboard/servers`, one server drawer, `/dashboard/libraries`, one library drawer, and `/dashboard/system` at desktop and mobile widths. Compare against:

Use an isolated temporary data directory and the existing Vite proxy:

```bash
demo_data_dir="$(mktemp -d)"
HOST=127.0.0.1 PORT=3000 DATA_DIR="$demo_data_dir" \
  MIGRATIONS_DIR=apps/server/migrations ASSETS_DIR=apps/dashboard/dist \
  bun apps/server/src/platform/bun/index.ts
cd apps/dashboard && bun run dev
```

Verify `/dashboard/`, `/dashboard/servers`, one server drawer, `/dashboard/libraries`, one library drawer, and `/dashboard/system` at desktop and mobile widths. Compare against:

- `.design/dashboard-prototype/screenshots/dashboard-desktop.png`
- `.design/dashboard-prototype/screenshots/dashboard-mobile.png`
- `.design/dashboard-prototype/screenshots/server-cards-standard.png`
- `.design/dashboard-prototype/screenshots/server-drawer.png`
- `.design/dashboard-prototype/screenshots/system-compact.png`

Record only observed runtime behavior. Apply one batched defect fix if needed, then perform at most one confirmation pass.

- [ ] **Step 5: Run final checks and commit acceptance coverage**

Run: `bun run check && cd apps/server && bun run test:workers`

Expected: PASS.

```bash
git add packages apps bun.lock
git commit -m "test: verify dashboard alignment across runtimes"
```
