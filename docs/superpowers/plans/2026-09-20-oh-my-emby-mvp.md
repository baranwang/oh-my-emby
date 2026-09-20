# oh-my-emby MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first self-hosted oh-my-emby release: one Emby-compatible virtual server that aggregates multiple upstream Emby libraries, preserves selectable versions, owns local user state, and deploys unchanged to Cloudflare Workers/D1 and Docker/Bun/SQLite.

**Architecture:** A platform-neutral Effect v4 core owns contracts, identity, federation, state, and playback decisions. Thin Workers and Bun adapters supply HTTP, SQL, scheduling, static assets, and bounded response caches. The React Dashboard consumes the same Effect `HttpApi` contract and remains a client-only `/dashboard` SPA.

**Tech Stack:** Bun `1.4.2` workspaces/package manager/runtime, Turborepo, TypeScript 7, Effect `4.0.0-rc.112`, `@effect/platform-bun@4.0.0-rc.112`, `@effect/sql-sqlite-bun@4.0.0-rc.112`, React 19, Vite 8, shadcn/ui, TanStack Router 1, TanStack Query 5, TanStack Form 1, Paraglide JS 2, Vitest 5, Wrangler 4, D1, Bun SQLite, Docker.

**Spec:** `docs/superpowers/specs/2026-09-20-emby-aggregation-architecture-design.md` and `docs/superpowers/specs/2026-09-20-dashboard-frontend-design.md`

## Global Constraints

- Pin `effect`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun` to `4.0.0-rc.112` exactly; do not install the packages' Effect 3 `latest` tags.
- Keep `apps/server`, `apps/dashboard`, and `packages/contracts`; do not add speculative workspace packages.
- Bun is the only package manager and JavaScript script runner. Use Bun workspaces and commit only `bun.lock`. Production runtimes are Workers and Bun only; Node.js is absent from the Docker runtime image.
- One deployment has one local user and one virtual Emby server. Additional groups use additional deployments.
- Merge only exact, cluster-compatible typed external IDs. Never add title/year/runtime heuristics or a full-library scan.
- Video delivery returns one authenticated, private, non-cacheable HTTP 302 and never proxies video bytes.
- Browser production access requires the configured HTTPS public origin; HTTP is localhost-development-only.
- Secrets are write-only, redacted, and excluded from DTOs, errors, logs, cache metadata, and ordinary response bodies.
- Workers use D1, Cron Triggers, and Static Assets with Worker-first routing and `html_handling: "none"`; do not add Queues or Durable Objects.
- Docker uses one Bun process, one SQLite file, and prebuilt Dashboard assets; do not add a second web server.
- Dashboard uses shadcn source components, TanStack Router/Query/Form, and Paraglide; do not add a client state store, data-grid, SSR, SSE, or WebSockets.
- Use these initial bounded-work constants in `apps/server/src/core/limits.ts`: `MAX_CONFIGURED_UPSTREAMS = 10`, `MAX_FANOUT_CONCURRENCY = 4`, `MAX_PAGE_SIZE = 100`, `MAX_MATERIALIZED_ITEMS = 2_000`, `DB_BATCH_SIZE = 100`, `UPSTREAM_LIST_DEADLINE_MS = 5_000`, `UPSTREAM_DETAIL_DEADLINE_MS = 8_000`, `MAX_CONTROL_RESPONSE_BYTES = 8 * 1024 * 1024`, `QUERY_GENERATION_TTL_MS = 15 * 60_000`, `METADATA_FRESH_MS = 15 * 60_000`, `METADATA_STALE_MS = 24 * 60 * 60_000`, `PLAYBACK_RESOLUTION_TTL_MS = 60_000`, `OUTBOX_BATCH_SIZE = 50`, `OUTBOX_LEASE_MS = 60_000`, `OUTBOX_MAX_BACKOFF_MS = 6 * 60 * 60_000`, `UNCERTAINTY_REAPPLY_MS = 15 * 60_000`, `MAX_IMAGE_BYTES = 20 * 1024 * 1024`, `MAX_SUBTITLE_BYTES = 5 * 1024 * 1024`, `AUXILIARY_PROXY_DEADLINE_MS = 15_000`, `IMAGE_CACHE_TTL_MS = 6 * 60 * 60_000`, and `BUN_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024`.
- Authentication constants are `PBKDF2_ITERATIONS = 310_000`, `DASHBOARD_SESSION_IDLE_MS = 7 * 24 * 60 * 60_000`, `AUTH_RATE_WINDOW_MS = 15 * 60_000`, `AUTH_RATE_MAX_ATTEMPTS = 5`, and `AUTH_RATE_BLOCK_MS = 15 * 60_000`; Task 15 benchmarks PBKDF2 on Workers and Bun before release.
- All generated IDs and bearer/session tokens use Web Crypto. PBKDF2 parameters are stored per user and benchmarked on both target runtimes before release.
- Every task ends in a signed commit. Never bypass signing; if signing fails, stop and fix the signing environment.

## Review Focus

- Redirect and destination-policy inputs: mixed-case hosts, credentials in URLs, IP literals, DNS changes, cross-origin hops, HTTPS downgrade, and unregistered resource URLs must not leak credentials or become SSRF primitives; Task 5 and Task 10 pin these cases.
- Configuration-generation races: a response started before a base URL, credential, or authentication-policy change must not persist mappings/cache, resolve playback, or acknowledge outbox work; Task 5, Task 7, and Task 8 pin this.
- Identity conflict inputs: sparse bridges, contradictory provider IDs, combined episodes, child-before-parent discovery, and late aliases must preserve existing canonical IDs and user state; Task 6 pins this.
- Outbox timing inputs: expired leases, owner loss, timeout after dispatch, late unobserved writes, and newer acknowledgements must still converge to the latest desired state; Task 8 pins this.
- Pagination inputs: duplicate-heavy pages, partial source failure, count increase/decrease, deep offsets, and terminal empty pages must remain bounded and SenPlayer-compatible; Task 7 and Task 15 pin this.

---

## File and Responsibility Map

```text
package.json                         # Bun workspaces and root commands
bun.lock                             # sole dependency lockfile
turbo.json                           # build, typecheck, test task graph
tsconfig.base.json                   # strict shared compiler options

packages/contracts/
  src/dashboard.ts                   # Dashboard HttpApi and endpoint groups
  src/schemas.ts                     # shared public request/response schemas
  src/errors.ts                      # typed public error schemas
  src/index.ts                       # public package surface

apps/server/
  migrations/0001_initial.sql        # shared logical schema
  src/core/limits.ts                 # all bounded-work constants
  src/core/model.ts                  # domain value types
  src/core/errors.ts                 # internal typed failures
  src/core/repositories.ts           # platform-neutral repository services
  src/core/auth.ts                   # claim, login, tokens, sessions, origin checks
  src/core/upstream-client.ts        # URL, auth, UA, redirects, response limits
  src/core/identity.ts               # exact-ID clustering and durable aliases
  src/core/federation.ts             # fan-out, cache, query generations, enrichment
  src/core/user-state.ts             # local desired state and playback-event folding
  src/core/outbox.ts                 # leases, delivery, uncertainty reconciliation
  src/core/playback.ts               # version selection and redirect/resource decisions
  src/core/maintenance.ts            # one bounded maintenance operation
  src/api/dashboard.ts               # DashboardApi implementation
  src/api/emby.ts                    # Emby-compatible routes and DTO mapping
  src/api/application.ts             # common route ordering and error serialization
  src/platform/workers/              # D1, Worker fetch/scheduled, Static Assets
  src/platform/bun/                  # Bun SQLite, HTTP listener, filesystem assets/timer
  test/                              # core, contract, conformance, platform tests

apps/dashboard/
  src/routes/                        # thin TanStack Router files
  src/modules/                       # auth/setup/servers/libraries/system vertical slices
  src/components/ui/                 # shadcn-managed source
  src/components/app-shell/          # shell and navigation
  src/lib/                           # API client, Query client, keys, auth cache handling
  messages/                          # en.json and zh-CN.json
  src/paraglide/                     # generated Paraglide output
  src/index.css                      # approved shadcn preset tokens

docs/compatibility/senplayer.md      # captured real-client evidence
Dockerfile                           # Bun-only production image
compose.yaml                         # one service and one persistent volume
.github/workflows/ci.yml             # static, unit, integration, and build gates
```

The execution order is intentional: Tasks 1–5 establish compile-time and persistence contracts; Tasks 6–10 implement the core behavior; Tasks 11–12 consume the finished Dashboard API; Tasks 13–14 add platform adapters; Task 15 records real-runtime acceptance. Do not parallelize tasks that consume interfaces from an unfinished earlier task.

### Task 1: Bootstrap the Monorepo and Bounded Core

**Files:**
- Create: `package.json`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/core/limits.ts`
- Create: `apps/server/test/limits.test.ts`
- Create: `apps/dashboard/package.json`
- Create: `apps/dashboard/tsconfig.json`
- Create: `apps/dashboard/vite.config.ts`
- Create: `apps/dashboard/index.html`
- Create: `apps/dashboard/src/main.tsx`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: the exact dependency/runtime constraints and bounded-work values in this plan.
- Produces: workspace scripts `build`, `typecheck`, `test`, and `check`; exported numeric constants from `apps/server/src/core/limits.ts`.

- [ ] **Step 1: Write the failing limits test**

```ts
import { describe, expect, it } from "vitest"
import {
  DB_BATCH_SIZE,
  MAX_CONFIGURED_UPSTREAMS,
  MAX_FANOUT_CONCURRENCY,
  MAX_MATERIALIZED_ITEMS,
  MAX_PAGE_SIZE,
  PBKDF2_ITERATIONS
} from "../src/core/limits.js"

describe("bounded core", () => {
  it("keeps public and database work inside explicit ceilings", () => {
    expect(MAX_CONFIGURED_UPSTREAMS).toBe(10)
    expect(MAX_FANOUT_CONCURRENCY).toBeLessThanOrEqual(MAX_CONFIGURED_UPSTREAMS)
    expect(MAX_PAGE_SIZE).toBe(100)
    expect(MAX_MATERIALIZED_ITEMS).toBeGreaterThanOrEqual(MAX_PAGE_SIZE)
    expect(DB_BATCH_SIZE).toBeLessThanOrEqual(100)
    expect(PBKDF2_ITERATIONS).toBe(310_000)
  })
})
```

- [ ] **Step 2: Create the workspace manifests and verify the test fails**

Use `packageManager: "bun@1.4.2"`, `engines.bun: ">=1.4.2"`, and root `workspaces: ["apps/*", "packages/*"]`. Pin `effect: "4.0.0-rc.112"` in server/contracts and exact `4.0.0-rc.112` versions for both Bun Effect adapters. Root scripts are:

```json
{
  "scripts": {
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "check": "turbo run typecheck test build"
  }
}
```

Run: `bun install && bun --filter @oh-my-emby/server test -- limits.test.ts`

Expected: FAIL because `src/core/limits.ts` does not exist.

- [ ] **Step 3: Add the exact limits and minimal package scripts**

```ts
export const MAX_CONFIGURED_UPSTREAMS = 10
export const MAX_FANOUT_CONCURRENCY = 4
export const MAX_PAGE_SIZE = 100
export const MAX_MATERIALIZED_ITEMS = 2_000
export const DB_BATCH_SIZE = 100
export const UPSTREAM_LIST_DEADLINE_MS = 5_000
export const UPSTREAM_DETAIL_DEADLINE_MS = 8_000
export const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024 * 1024
export const QUERY_GENERATION_TTL_MS = 15 * 60_000
export const METADATA_FRESH_MS = 15 * 60_000
export const METADATA_STALE_MS = 24 * 60 * 60_000
export const OUTBOX_BATCH_SIZE = 50
export const OUTBOX_LEASE_MS = 60_000
export const UNCERTAINTY_REAPPLY_MS = 15 * 60_000
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024
export const AUXILIARY_PROXY_DEADLINE_MS = 15_000
export const PLAYBACK_RESOLUTION_TTL_MS = 60_000
export const OUTBOX_MAX_BACKOFF_MS = 6 * 60 * 60_000
export const IMAGE_CACHE_TTL_MS = 6 * 60 * 60_000
export const BUN_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024
export const PBKDF2_ITERATIONS = 310_000
export const DASHBOARD_SESSION_IDLE_MS = 7 * 24 * 60 * 60_000
export const AUTH_RATE_WINDOW_MS = 15 * 60_000
export const AUTH_RATE_MAX_ATTEMPTS = 5
export const AUTH_RATE_BLOCK_MS = 15 * 60_000
```

Set TypeScript to `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `moduleResolution: "Bundler"`. Configure Turbo so `test` and `typecheck` depend on dependency-package builds and never cache runtime integration results. Give server/contracts `tsc -p tsconfig.json` builds and Vitest tests. Give Dashboard a minimal React mount plus Vite build now so the workspace gate is real; Task 11 replaces that mount with the routed application. `packages/contracts/src/index.ts` starts as `export {}`. Add the unmodified AGPL-3.0 license text.

- [ ] **Step 4: Run the workspace baseline**

Run: `bun run check`

Expected: all three packages typecheck; the one limits test passes; Dashboard and server build empty entry points without production code.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock turbo.json tsconfig.base.json .gitignore LICENSE apps packages
git commit -S -m "chore: bootstrap bun monorepo"
```

### Task 2: Define Shared Dashboard Contracts and Public Errors

**Files:**
- Create: `packages/contracts/src/schemas.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/dashboard.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/dashboard.test.ts`

**Interfaces:**
- Consumes: `effect/Schema` and `effect/unstable/httpapi` from Effect `4.0.0-rc.112`.
- Produces: `DashboardApi`; `BootstrapView`, `SessionView`, `ServerInput`, `ServerView`, `SourceLibraryView`, `VirtualLibraryInput`, `VirtualLibraryView`, `SystemStatusView`, `OutboxFailureView`; `PublicError` union.

- [ ] **Step 1: Write schema round-trip and redaction tests**

```ts
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ServerInput, ServerView } from "../src/index.js"

describe("Dashboard contracts", () => {
  it("accepts write-only credentials but never returns them", async () => {
    const input = await Schema.decodeUnknownPromise(ServerInput)({
      name: "Home",
      baseUrl: "https://emby.example.com",
      username: "alice",
      password: { _tag: "Set", value: "secret" },
      userAgent: "SenPlayer/1",
      enabled: true
    })
    expect(input.password._tag).toBe("Set")
    const view = await Schema.decodeUnknownPromise(ServerView)({
      id: "server-1",
      name: "Home",
      baseUrl: "https://emby.example.com",
      username: "alice",
      hasPassword: true,
      userAgent: "SenPlayer/1",
      enabled: true,
      verifiedCatalogId: null,
      generation: 1,
      health: "unknown"
    })
    expect(view).not.toHaveProperty("password")
    expect(view).not.toHaveProperty("accessToken")
  })
})
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `bun --filter @oh-my-emby/contracts test -- dashboard.test.ts`

Expected: FAIL because the shared schemas do not exist.

- [ ] **Step 3: Implement the public schema surface**

Use branded non-empty IDs, `Schema.URL`-validated HTTP(S) strings, and a three-way secret patch so edit forms cannot confuse preserve and clear:

```ts
import { Schema } from "effect"

export const SecretPatch = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Preserve") }),
  Schema.Struct({ _tag: Schema.Literal("Set"), value: Schema.NonEmptyString }),
  Schema.Struct({ _tag: Schema.Literal("Clear") })
])

export const ServerInput = Schema.Struct({
  name: Schema.NonEmptyString,
  baseUrl: Schema.NonEmptyString,
  username: Schema.NonEmptyString,
  password: SecretPatch,
  userAgent: Schema.NonEmptyString,
  enabled: Schema.Boolean
})

export const ServerView = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  baseUrl: Schema.NonEmptyString,
  username: Schema.NonEmptyString,
  hasPassword: Schema.Boolean,
  userAgent: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  verifiedCatalogId: Schema.NullOr(Schema.NonEmptyString),
  generation: Schema.Int,
  health: Schema.Literals(["unknown", "healthy", "degraded"])
})
```

Define `PublicError` as tagged schemas for `Unauthorized`, `ForbiddenOrigin`, `ValidationFailed` with field errors, `NotFound`, `Conflict`, `UpstreamUnavailable`, `UpstreamRejected`, `Timeout`, `MaterializationLimit`, and `Internal`. `Internal` has only a request ID. Define HttpApi groups `bootstrap`, `auth`, `servers`, `libraries`, and `system` under `/api/dashboard`; every mutation declares its typed success and error schemas.

- [ ] **Step 4: Verify contracts and declaration output**

Run: `bun --filter @oh-my-emby/contracts test && bun --filter @oh-my-emby/contracts typecheck && bun --filter @oh-my-emby/contracts build`

Expected: schema tests pass; generated declarations expose only the named public surface; no password/token field exists in response schemas.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -S -m "feat: define dashboard api contracts"
```

### Task 3: Create the Shared SQL Schema and Repository Boundary

**Files:**
- Create: `apps/server/migrations/0001_initial.sql`
- Create: `apps/server/src/core/model.ts`
- Create: `apps/server/src/core/errors.ts`
- Create: `apps/server/src/core/repositories.ts`
- Create: `apps/server/test/repository-contract.ts`
- Create: `apps/server/test/sqlite-repository.test.ts`
- Create: `apps/server/src/platform/bun/sqlite-repositories.ts`

**Interfaces:**
- Consumes: shared schemas from Task 2 and `bun:sqlite` through `@effect/sql-sqlite-bun@4.0.0-rc.112`.
- Produces: `Repositories` Effect service with transaction-safe methods; reusable `repositoryContract(makeLayer)` test suite; first real SQLite adapter.

- [ ] **Step 1: Write the repository conformance test first**

```ts
export const repositoryContract = (harness: RepositoryHarness) => {
  it("claims the singleton user exactly once", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      const first = yield* repo.claimUser({ username: "owner", password: passwordRecord })
      const second = yield* Effect.flip(repo.claimUser({ username: "other", password: passwordRecord }))
      expect(first.username).toBe("owner")
      expect(second._tag).toBe("AlreadyInitialized")
    }).pipe(Effect.provide(harness.layer)))
  })

  it("rolls back state when atomic outbox creation fails", async () => {
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await harness.failNext("state_outbox_insert")
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* Effect.flip(repo.writeUserStateAndTargets(stateFixture))
    }).pipe(Effect.provide(harness.layer)))
    expect(await harness.getUserState(canonicalFixture.id)).toBeNull()
  })
}
```

`RepositoryHarness` is test-only and keeps fault injection out of the production service:

```ts
export interface RepositoryHarness {
  readonly layer: Layer.Layer<Repositories>
  readonly seedCanonicalWithEligibleSources: (fixture: CanonicalFixture) => Promise<void>
  readonly failNext: (operation: "state_outbox_insert") => Promise<void>
  readonly getUserState: (canonicalId: string) => Promise<UserStateRecord | null>
}
```

- [ ] **Step 2: Run the SQLite contract to verify it fails**

Run: `bun --filter @oh-my-emby/server test -- sqlite-repository.test.ts`

Expected: FAIL because the migration, service, and adapter do not exist.

- [ ] **Step 3: Add the migration and repository service**

The migration creates every table named in the architecture spec, with these non-negotiable constraints:

```sql
CREATE TABLE users (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash BLOB NOT NULL,
  password_salt BLOB NOT NULL,
  pbkdf2_iterations INTEGER NOT NULL CHECK (pbkdf2_iterations > 0),
  auth_generation INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE upstream_servers (
  id TEXT PRIMARY KEY,
  catalog_namespace TEXT NOT NULL UNIQUE,
  verified_catalog_id TEXT UNIQUE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT,
  access_token TEXT,
  access_token_expires_at_ms INTEGER,
  user_agent TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  health TEXT NOT NULL CHECK (health IN ('unknown', 'healthy', 'degraded')),
  last_success_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE user_state (
  canonical_id TEXT PRIMARY KEY REFERENCES canonical_items(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  played INTEGER NOT NULL CHECK (played IN (0, 1)),
  favorite INTEGER NOT NULL CHECK (favorite IN (0, 1)),
  play_count INTEGER NOT NULL CHECK (play_count >= 0),
  position_ticks INTEGER NOT NULL CHECK (position_ticks >= 0),
  last_played_version_id TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;
```

Use this exact column/key map for the remaining tables; JSON columns are canonical JSON text and every boolean is constrained to `0 | 1`:

| Table | Required columns and keys |
| --- | --- |
| `emby_tokens` | `id`, `user_singleton` FK, unique `token_hash`, `auth_generation`, `device_id`, `device_name`, `created_at_ms`, `last_used_at_ms`, `expires_at_ms` |
| `dashboard_sessions` | `id`, `user_singleton` FK, unique `token_hash`, `auth_generation`, `created_at_ms`, `last_seen_at_ms`, `expires_at_ms` |
| `auth_rate_limits` | composite PK `scope_key, window_started_at_ms`, `attempt_count`, `blocked_until_ms` |
| `virtual_libraries` | `id` PK, `name`, `media_type` (`movies` or `series`), `enabled`, `created_at_ms`, `updated_at_ms` |
| `library_sources` | composite PK `virtual_library_id, server_id, source_library_id`; FKs to library/server; `source_library_name`, `media_type`, `source_order`, `enabled` |
| `canonical_items` | `id` PK, `item_type`, `identity_state`, `display_metadata_json`, `created_at_ms`, `updated_at_ms` |
| `canonical_aliases` | `alias_id` PK, `canonical_id` FK, `retired_at_ms` |
| `identity_claims` | composite PK `canonical_id, namespace`; `value`, `state`, `source_item_id`, `created_at_ms`; index `namespace, value` |
| `source_items` | `id` PK, `server_id` FK, `catalog_namespace`, `server_generation`, `source_library_id`, `upstream_item_id`, `item_type`, nullable `canonical_id` FK, `quarantine_reason`, `created_at_ms`, `updated_at_ms`; unique `catalog_namespace, upstream_item_id, item_type` |
| `source_media_versions` | `id` PK, `source_item_id` FK, `server_generation`, `upstream_media_source_id`, `label`, `capabilities_json`, `streams_json`, `updated_at_ms`; unique `source_item_id, upstream_media_source_id` |
| `source_metadata_cache` | composite PK `source_item_id, projection_key`; `payload_json`, `fresh_until_ms`, `stale_until_ms`, `updated_at_ms` |
| `query_generations` | `id` PK, unique `query_key`; `user_key`, `device_id`, `virtual_library_id` FK, `normalized_query_json`, `source_state_json`, `all_sources_exhausted`, `state_dependent`, `created_at_ms`, `expires_at_ms` |
| `query_generation_items` | composite PK `generation_id, ordinal`; unique `generation_id, canonical_id`; `canonical_id` FK, `sort_values_json` |
| `state_outbox` | `target_id` PK, `canonical_id` FK, `source_item_id` FK, `server_id` FK, `server_generation`, `desired_revision`, `delivered_revision`, `payload_json`, `attempt_count`, `next_attempt_at_ms`, `lease_owner`, `lease_expires_at_ms`, `dispatched_at_ms`, `uncertain_since_ms`, `permanent_failure_code`, `eligible`, `updated_at_ms` |
| `playback_sessions` | `id` PK, `canonical_id` FK, `version_id`, `started_at_ms`, `last_event_at_ms`, `last_position_ticks`, `stop_applied`, `state_revision` |
| `schema_migrations` | `version` PK, `name`, `applied_at_ms` |

Add indexes for due/uncertain outbox claims, cache expiry, query expiry, source lookup, external claims, session/token hashes, rate-limit expiry, and ordered library bindings. Enable foreign keys for every connection.

Define one Effect service instead of one interface per table. `RepositoriesService` contains the named methods and their exact domain input/output types; platform adapters provide the class-style v4 service key:

```ts
export interface RepositoriesService {
  readonly claimUser: (input: ClaimUserInput) => Effect.Effect<UserRecord, ClaimError>
  readonly getUserByName: (username: string) => Effect.Effect<UserRecord | null, RepositoryError>
  readonly issueDashboardSession: (input: SessionIssue) => Effect.Effect<SessionRecord, AuthError>
  readonly issueEmbyToken: (input: TokenIssue) => Effect.Effect<TokenRecord, AuthError>
  readonly revokeAuthentication: (input: PasswordReplacement) => Effect.Effect<void, AuthError>
  readonly listServers: () => Effect.Effect<ReadonlyArray<UpstreamServer>, RepositoryError>
  readonly saveServer: (input: SaveServerCommand) => Effect.Effect<UpstreamServer, RepositoryError>
  readonly listVirtualLibraries: () => Effect.Effect<ReadonlyArray<VirtualLibrary>, RepositoryError>
  readonly saveVirtualLibrary: (input: SaveVirtualLibraryCommand) => Effect.Effect<VirtualLibrary, RepositoryError>
  readonly deleteVirtualLibrary: (id: string) => Effect.Effect<void, RepositoryError>
  readonly resolveEligibleSources: (libraryId: string) => Effect.Effect<ReadonlyArray<EligibleSource>, RepositoryError>
  readonly persistIdentityResult: (result: IdentityResolution) => Effect.Effect<CanonicalItem, IdentityFailure>
  readonly readQueryGeneration: (key: string) => Effect.Effect<QueryGeneration | null, RepositoryError>
  readonly appendQueryGenerationItems: (input: QueryGenerationAppend) => Effect.Effect<void, RepositoryError>
  readonly writeUserStateAndTargets: (input: StateWrite) => Effect.Effect<UserStateRecord, RepositoryError>
  readonly claimOutboxTargets: (input: ClaimRequest) => Effect.Effect<ReadonlyArray<OutboxClaim>, RepositoryError>
  readonly acknowledgeOutboxTarget: (input: OutboxAcknowledgement) => Effect.Effect<boolean, RepositoryError>
  readonly markOutboxUncertain: (input: OutboxUncertainty) => Effect.Effect<void, RepositoryError>
  readonly runMaintenanceBatch: (nowMs: number) => Effect.Effect<MaintenanceResult, RepositoryError>
}

export class Repositories extends Context.Service<Repositories, RepositoriesService>()(
  "oh-my-emby/Repositories"
) {}
```

- [ ] **Step 4: Implement SQLite semantics and run the contract**

Use a fresh temporary SQLite file per test, apply `0001_initial.sql`, set `PRAGMA foreign_keys = ON`, store booleans as 0/1 and times as epoch milliseconds, and close/reopen once in the suite to prove persistence.

Run: `bun --filter @oh-my-emby/server test -- sqlite-repository.test.ts`

Expected: PASS for singleton claim, foreign keys, ordering, rollback, integer/boolean/time encoding, lease claims, and close/reopen behavior.

- [ ] **Step 5: Commit**

```bash
git add apps/server/migrations apps/server/src/core apps/server/src/platform/bun apps/server/test
git commit -S -m "feat: add shared data model and repositories"
```

### Task 4: Implement Local Authentication and Dashboard API Guards

**Files:**
- Create: `apps/server/src/core/auth.ts`
- Create: `apps/server/src/api/dashboard.ts`
- Create: `apps/server/test/auth.test.ts`
- Create: `apps/server/test/dashboard-auth.test.ts`

**Interfaces:**
- Consumes: `Repositories`, `DashboardApi`, Web Crypto, configured public origin, and trusted-proxy policy.
- Produces: `Auth` service methods `claim`, `loginDashboard`, `loginEmby`, `authenticateDashboard`, `authenticateEmby`, `logoutDashboard`, `changePassword`; guarded Dashboard HttpApi handlers.

- [ ] **Step 1: Write the authentication race and boundary tests**

```ts
it("fences a login that verified the old password", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const gate = yield* Deferred.make<void>()
    const login = Auth.loginDashboard(oldCredentials, { afterVerify: Deferred.await(gate) }).pipe(Effect.fork)
    yield* Auth.changePassword(currentSession, newPassword)
    yield* Deferred.succeed(gate, undefined)
    expect((yield* Effect.flip(Fiber.join(login)))._tag).toBe("AuthenticationChanged")
  }))
})

it("keeps the instance initialized when first-server setup fails", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    yield* Auth.claim({ username: "owner", password: "valid password" })
    yield* Effect.flip(saveFirstServer(unreachableServer))
    expect((yield* Auth.bootstrap()).initialized).toBe(true)
  }))
})
```

Add cases for two simultaneous claims, invalid credentials, rolling seven-day session expiry, logout, password-change revocation of both token families, cookie flags, same-origin mutation rejection, localhost HTTP development, arbitrary forwarded-header rejection, and rate limiting.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- auth.test.ts dashboard-auth.test.ts`

Expected: FAIL because `Auth` and Dashboard handlers do not exist.

- [ ] **Step 3: Implement password, token, session, and generation logic**

```ts
export interface PasswordRecord {
  readonly hash: Uint8Array
  readonly salt: Uint8Array
  readonly iterations: number
}

export interface AuthService {
  readonly claim: (input: ClaimInput) => Effect.Effect<SessionView, ClaimError>
  readonly loginDashboard: (input: Credentials) => Effect.Effect<SessionCookie, LoginError>
  readonly loginEmby: (input: EmbyLoginInput) => Effect.Effect<EmbyTokenView, LoginError>
  readonly changePassword: (session: SessionPrincipal, input: ChangePasswordInput) => Effect.Effect<void, AuthError>
}
```

Generate 16-byte salts and 32-byte random tokens with `crypto.getRandomValues`; hash stored bearer/session tokens with SHA-256; derive passwords with PBKDF2-SHA-256 and constant-time byte comparison. The issuance transaction rechecks `auth_generation`; password change increments it and deletes all token/session rows atomically. Set Dashboard cookies `HttpOnly; Secure; SameSite=Lax; Path=/api/dashboard`; this is the narrowest path that still covers the typed API rooted at `/api/dashboard`. Update rolling expiry only after half the seven-day inactivity window has elapsed to avoid a write on every request.

- [ ] **Step 4: Build guarded HttpApi handlers and rerun tests**

Map tagged domain failures to the Task 2 public errors. Require exact configured `Origin` for mutations; derive secure-request status only from the public origin and an explicit allowlist of trusted proxy addresses. Return no password hash, salt, token hash, raw token after issuance, or stack trace.

Run: `bun --filter @oh-my-emby/server test -- auth.test.ts dashboard-auth.test.ts`

Expected: PASS, including the old-password login race and zero-upstream resumable setup.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/auth.ts apps/server/src/api/dashboard.ts apps/server/test/auth.test.ts apps/server/test/dashboard-auth.test.ts
git commit -S -m "feat: add single-user authentication"
```

### Task 5: Build the Upstream Client, Server, and Library Control Plane

**Files:**
- Create: `apps/server/src/core/upstream-client.ts`
- Create: `apps/server/src/core/server-service.ts`
- Create: `apps/server/src/core/library-service.ts`
- Create: `apps/server/src/core/observability.ts`
- Modify: `apps/server/src/api/dashboard.ts`
- Create: `apps/server/test/upstream-client.test.ts`
- Create: `apps/server/test/server-service.test.ts`
- Create: `apps/server/test/library-service.test.ts`
- Create: `apps/server/test/observability.test.ts`

**Interfaces:**
- Consumes: `Repositories`, server request/response schemas, limits, and platform `fetch`.
- Produces: `UpstreamClient.request`, `authenticate`, `getServerIdentity`, `listSourceLibraries`, `resolvePlayback`; `ServerService` CRUD/test/discovery operations with generation fencing; `LibraryService` CRUD and ordered source bindings.

- [ ] **Step 1: Write URL-policy, header, and generation-race tests**

```ts
it("drops credentials and identity headers on a cross-origin redirect", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const calls = yield* Ref.make<ReadonlyArray<Request>>([])
    const client = yield* UpstreamClient
    yield* client.request(serverFixture, "/System/Info", mockRedirectFetch(calls))
    const [, redirected] = yield* Ref.get(calls)
    expect(redirected.headers.has("X-Emby-Token")).toBe(false)
    expect(redirected.headers.has("Authorization")).toBe(false)
    expect(redirected.headers.has("X-Emby-Authorization")).toBe(false)
  }))
})

it("rejects persistence from an obsolete configuration generation", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const request = yield* ServerService.beginRequest(serverId)
    yield* ServerService.update(serverId, changedCredentials)
    expect((yield* Effect.flip(ServerService.persistResult(request, fixtureResult)))._tag)
      .toBe("ObsoleteGeneration")
  }))
})
```

Add cases for URL credentials, unsupported schemes, mixed-case host normalization, IPv4/IPv6 literals under Workers policy, Docker administrator-configured private destinations, three-hop maximum, redirect loop, HTTPS downgrade, oversized JSON, timeout/cancellation, token refresh isolated per server, configured User-Agent, arbitrary inbound-header rejection, and source-library IDs stable across display-name changes.

Add library cases for movies-versus-series binding validation, ordered sources, disabled bindings, deletion preserving canonical state, removal leaving a source eligible through another enabled library, and rejection of an unverified or disabled server.

Add log-capture cases asserting request ID, route, server ID, duration, cache/retry outcome, and typed failure category are structured fields while credentials, tokens, authorization headers, request bodies, raw upstream bodies, and token-bearing URLs never appear in keys or serialized values.

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- upstream-client.test.ts server-service.test.ts library-service.test.ts observability.test.ts`

Expected: FAIL because the client and service do not exist.

- [ ] **Step 3: Implement one upstream request path**

```ts
export interface UpstreamRequest {
  readonly serverId: string
  readonly generation: number
  readonly path: string
  readonly method: "GET" | "POST" | "DELETE"
  readonly body?: Uint8Array
  readonly resourcePolicy?: "control" | "registered-resource"
}

export interface UpstreamClientService {
  readonly request: <A>(request: UpstreamRequest, schema: Schema.Schema<A>) =>
    Effect.Effect<A, UpstreamFailure>
  readonly authenticate: (server: UpstreamServer) => Effect.Effect<AuthenticatedServer, UpstreamFailure>
  readonly listSourceLibraries: (serverId: string) => Effect.Effect<ReadonlyArray<SourceLibrary>, UpstreamFailure>
  readonly resolvePlayback: (version: SourceMediaVersion) => Effect.Effect<ResolvedPlayback, UpstreamFailure>
}
```

Normalize with `new URL`, reject embedded credentials, handle redirects manually, re-evaluate the destination on every hop, and allowlist only required Emby headers. Read bounded JSON through a counted stream reader; never call unbounded `response.text()` or `response.json()`. Retry once only for idempotent control requests after classified transient transport failure. Never retry validation, authentication rejection, explicit not-found, or non-idempotent state setters.

`observability.ts` emits JSON records through Effect logging annotations. Redact by construction: callers provide only request ID, route template, local server ID, duration, cache outcome, retry outcome, and tagged failure category. The logging API accepts no request/response body, credential, authorization header, or URL value.

- [ ] **Step 4: Implement server CRUD, test connection, identity verification, and discovery**

Changing base URL, username, password, or auth policy increments `generation` and clears cached authentication in one transaction. A base-URL edit remains saved but ineligible until `getServerIdentity` returns the existing verified catalog ID. A different stable identity returns `CatalogIdentityMismatch`; it never reuses old bindings. `testConnection` reports control-plane reachability only. Expose discovery through the existing `DashboardApi` without returning credentials or access tokens.

If an upstream exposes no stable server identity, the first verified endpoint may operate within its newly created namespace, but any later endpoint replacement is ineligible and returns `CatalogIdentityUnverifiable`; it cannot reuse mappings, bindings, playback, or outbox targets.

`LibraryService.save` validates one media type, at least one ordered source, stable discovered source-library IDs, enabled bindings, and the ten-server deployment ceiling. `delete` removes only bindings/library metadata; it does not delete canonical items or local user state. Eligibility queries count a source while any enabled virtual-library binding still references it.

Run: `bun --filter @oh-my-emby/server test -- upstream-client.test.ts server-service.test.ts library-service.test.ts observability.test.ts`

Expected: PASS for all redirect-policy, generation, User-Agent, discovery, and secret-redaction cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/upstream-client.ts apps/server/src/core/server-service.ts apps/server/src/core/library-service.ts apps/server/src/core/observability.ts apps/server/src/api/dashboard.ts apps/server/test/upstream-client.test.ts apps/server/test/server-service.test.ts apps/server/test/library-service.test.ts apps/server/test/observability.test.ts
git commit -S -m "feat: add upstream and library control plane"
```

### Task 6: Implement Exact Canonical Identity

**Files:**
- Create: `apps/server/src/core/identity.ts`
- Modify: `apps/server/src/core/repositories.ts`
- Modify: `apps/server/src/platform/bun/sqlite-repositories.ts`
- Create: `apps/server/test/identity.test.ts`

**Interfaces:**
- Consumes: normalized `SourceItemCandidate` records and repository identity transactions.
- Produces: `Identity.resolve(candidate): Effect<IdentityResolution, IdentityFailure>` and durable canonical IDs, aliases, typed claims, source mappings, and quarantine decisions.

- [ ] **Step 1: Write the identity matrix before implementation**

```ts
it.each([
  ["exact movie IDs", movie("a", { tmdbMovie: "10" }), movie("b", { tmdbMovie: "10" }), "merged"],
  ["type mismatch", movie("a", { tmdbMovie: "10" }), series("b", { tmdbTv: "10" }), "separate"],
  ["conflicting IMDb", movie("a", { tmdbMovie: "10", imdbTitle: "tt1" }), movie("b", { tmdbMovie: "10", imdbTitle: "tt2" }), "quarantined"],
  ["combined episode", episode("a", 1, 1), combinedEpisode("b", 1, [1, 2]), "separate"],
  ["special versus season one", episode("a", 0, 1), episode("b", 1, 1), "separate"]
])("handles %s", (_, left, right, expected) => {
  expect(resolvePair(left, right).decision).toBe(expected)
})
```

Add explicit tests for the sparse bridge X/Y/Z conflict, child-before-parent hydration failure, source-exclusive IDs based on verified catalog ID plus item ID, late compatible claims, alias lookup after consolidation, oldest-canonical survival, highest state revision winning, and a late conflict never moving existing state.

- [ ] **Step 2: Run the identity tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- identity.test.ts`

Expected: FAIL because `Identity.resolve` does not exist.

- [ ] **Step 3: Implement pure claim normalization and cluster compatibility**

```ts
export type ProviderNamespace = "tmdb:movie" | "tmdb:tv" | "imdb:title"
export interface ExternalClaim { readonly namespace: ProviderNamespace; readonly value: string }
export interface ClaimSet { readonly byNamespace: ReadonlyMap<ProviderNamespace, string> }

export const clustersCompatible = (left: ClaimSet, right: ClaimSet): boolean =>
  Array.from(left.byNamespace).every(([namespace, value]) => {
    const other = right.byNamespace.get(namespace)
    return other === undefined || other === value
  })
```

Normalize only documented typed namespaces; trim values but never case-fold opaque provider IDs. Movie/series clusters require at least one shared equal claim and no namespace conflict. Season fallback is canonical series plus season number. Episode fallback is canonical series plus season and episode numbers only when neither record is combined/conflicting. Unresolvable items use a deterministic hash of verified catalog ID, item type, and upstream item ID.

- [ ] **Step 4: Persist decisions atomically and rerun tests**

Inside one repository transaction: lock/read all matching claims, validate the complete cluster, create or select the oldest canonical ID, retain retired IDs in `canonical_aliases`, move compatible source mappings, preserve the highest user-state revision, and quarantine ambiguous new mappings without splitting an issued canonical. Recheck server generation before commit.

Run: `bun --filter @oh-my-emby/server test -- identity.test.ts sqlite-repository.test.ts`

Expected: PASS; every test observes stable aliases and unchanged state after conflict cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/identity.ts apps/server/src/core/repositories.ts apps/server/src/platform/bun/sqlite-repositories.ts apps/server/test/identity.test.ts
git commit -S -m "feat: add exact canonical identity"
```

### Task 7: Implement Federation, Cache, and Pagination Generations

**Files:**
- Create: `apps/server/src/core/federation.ts`
- Modify: `apps/server/src/core/repositories.ts`
- Modify: `apps/server/src/platform/bun/sqlite-repositories.ts`
- Create: `apps/server/test/federation.test.ts`
- Create: `apps/server/test/pagination.test.ts`

**Interfaces:**
- Consumes: `UpstreamClient`, `Identity`, eligible source bindings, query/cache repositories, and limits.
- Produces: `Federation.list`, `search`, `detail`, and `enrichVersions`; persisted query generations with stable ordinals.

- [ ] **Step 1: Write federation and pagination failure tests**

```ts
it("does not move published ordinals after metadata enrichment", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const first = yield* Federation.list(query({ startIndex: 0, limit: 2 }))
    yield* Federation.detail(first.items[0]!.id)
    const replay = yield* Federation.list(query({ startIndex: 0, limit: 2 }))
    expect(replay.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))
  }))
})

it("allows a provisional count to fall and then returns a terminal empty page", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const first = yield* Federation.list(query({ startIndex: 0, limit: 2 }))
    const second = yield* Federation.list(query({ startIndex: 2, limit: 2 }))
    const terminal = yield* Federation.list(query({ startIndex: 4, limit: 2 }))
    expect(second.totalRecordCount).toBeLessThan(first.totalRecordCount)
    expect(terminal.items).toEqual([])
    expect(terminal.exhausted).toBe(true)
  }))
})
```

Add cases for four-way concurrency across ten sources, per-source deadline, partial success, all-unavailable total miss, duplicate-heavy pages, deterministic tie-breaking, stale fallback only for transient failure, no stale on auth/not-found/generation change, lightweight projection not erasing richer metadata, local favorite/resume membership, state-filter bounded refill, deep-offset limit, and exact-ID version enrichment without fuzzy search.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- federation.test.ts pagination.test.ts`

Expected: FAIL because `Federation` does not exist.

- [ ] **Step 3: Implement bounded fan-out and projection-aware cache**

```ts
export interface FederatedQuery {
  readonly userId: string
  readonly deviceId: string
  readonly virtualLibraryId: string
  readonly startIndex: number
  readonly limit: number
  readonly sort: ReadonlyArray<SortTerm>
  readonly filters: ReadonlyArray<CatalogFilter>
}

export interface FederatedPage {
  readonly items: ReadonlyArray<CanonicalItemView>
  readonly totalRecordCount: number
  readonly exhausted: boolean
  readonly incompleteSourceIds: ReadonlyArray<string>
}
```

Clamp `limit` to 100, reject offsets that would require more than 2,000 materialized rows, and use Effect concurrency `4`. Always request provider IDs independent of client projections. Merge cache projections field-by-field so absent fields cannot erase present fields. Permit stale rows only until `METADATA_STALE_MS` and only after a transient failure. Exact detail/playback enrichment queries eligible sources by typed provider IDs and caches positive and negative results.

- [ ] **Step 4: Implement durable query generations**

Normalize query identity without offset/limit. Persist source participation, continuation, exhausted state, sort values, canonical IDs, and immutable published ordinals in chunks of 100. Refill until the requested window is full, the 2,000-row ceiling is reached, or all sources exhaust. While incomplete, return at least materialized count and one beyond the returned window when unread rows remain; permit the value to decrease after deduplication/filtering. Invalidate state-dependent generations after relevant local state writes.

Run: `bun --filter @oh-my-emby/server test -- federation.test.ts pagination.test.ts`

Expected: PASS, including count increases/decreases, partial failures, stable ordinals, and terminal empty pages.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/federation.ts apps/server/src/core/repositories.ts apps/server/src/platform/bun/sqlite-repositories.ts apps/server/test/federation.test.ts apps/server/test/pagination.test.ts
git commit -S -m "feat: add bounded catalog federation"
```

### Task 8: Implement Local User State, Outbox, and Maintenance

**Files:**
- Create: `apps/server/src/core/user-state.ts`
- Create: `apps/server/src/core/outbox.ts`
- Create: `apps/server/src/core/maintenance.ts`
- Modify: `apps/server/src/core/repositories.ts`
- Modify: `apps/server/src/platform/bun/sqlite-repositories.ts`
- Create: `apps/server/test/user-state.test.ts`
- Create: `apps/server/test/outbox.test.ts`
- Create: `apps/server/test/maintenance.test.ts`
- Modify: `apps/server/src/api/dashboard.ts`

**Interfaces:**
- Consumes: eligible source mappings, `Repositories`, `UpstreamClient`, clock/random owner services, and outbox limits.
- Produces: `UserState.write`, `recordPlaybackEvent`; `Outbox.deliverClaimed`; `runMaintenance(now)`; authenticated system status and secret-safe outbox failure handlers.

- [ ] **Step 1: Write state and reconciliation race tests**

```ts
it("reapplies the latest state after an unobserved old write completes late", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    yield* UserState.write(canonicalId, { played: false, favorite: false, positionTicks: 10 })
    const old = yield* Outbox.claimOne()
    yield* UserState.write(canonicalId, { played: true, favorite: true, positionTicks: 20 })
    yield* Outbox.deliverLatest()
    yield* Outbox.markAmbiguous(old, "owner-lost-after-dispatch")
    remote.completeLate(old)
    yield* TestClock.adjust(UNCERTAINTY_REAPPLY_MS)
    yield* runMaintenance()
    expect(remote.current()).toEqual({ played: true, favorite: true, positionTicks: 20 })
  }))
})
```

Add cases for atomic state/outbox rollback, eligible-target creation, mapping discovered after local edit, removed-source cancellation, lease owner mismatch, lease expiry, timeout after dispatch, stale acknowledgement, newer acknowledgement not clearing uncertainty, bounded batch claims, permanent failure retention, transient backoff, duplicate playback start/stop, delayed progress, and legitimate backward seek.

Add Dashboard API cases proving system status reports database/cache/maintenance/outbox/upstream health, outbox failures expose only typed code/time/attempt/server fields, and no payload, URL, token, password, or raw upstream body reaches the response.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- user-state.test.ts outbox.test.ts maintenance.test.ts`

Expected: FAIL because state/outbox services do not exist.

- [ ] **Step 3: Implement atomic desired state and event folding**

```ts
export interface DesiredUserState {
  readonly played: boolean
  readonly favorite: boolean
  readonly playCount: number
  readonly positionTicks: number
  readonly lastPlayedVersionId: string | null
}

export interface OutboxClaim {
  readonly targetId: string
  readonly desiredRevision: number
  readonly payload: DesiredUserState
  readonly leaseOwner: string
  readonly leaseExpiresAtMs: number
}
```

Increment canonical revision and upsert every eligible target in one transaction. Coalesce played/play count/position into one absolute desired payload. Track playback sessions by local session ID so repeated stops are idempotent, older session progress cannot replace newer progress, and a lower position within the same current session remains a valid seek.

- [ ] **Step 4: Implement lease delivery and persistent uncertainty**

Claim at most 50 due rows with a 60-second lease. Acknowledge only when owner and claimed revision still match. Every post-dispatch timeout, owner loss, and expired dispatched lease sets `uncertain_since_ms`; a newer acknowledgement leaves it set. Every 15 minutes, maintenance makes the latest desired revision due again for uncertain eligible targets even when delivered equals desired. Permanent failures remain visible; transient failures use capped exponential backoff. Maintenance also deletes expired sessions/query generations/cache rows in bounded batches and never scans upstream catalogs.

The same bounded cleanup removes expired authentication rate-limit windows and prunes the platform image cache through `ResourceCache.prune` without reading upstream catalogs.

Implement `GET /api/dashboard/system` and `GET /api/dashboard/system/outbox-failures` from repository aggregates. Expose retry status read-only in the MVP; ordinary maintenance owns retries, so the Dashboard cannot clear uncertainty or delete failures.

Run: `bun --filter @oh-my-emby/server test -- user-state.test.ts outbox.test.ts maintenance.test.ts sqlite-repository.test.ts`

Expected: PASS, including the unobserved late-completion scenario and overlapping maintenance workers.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/user-state.ts apps/server/src/core/outbox.ts apps/server/src/core/maintenance.ts apps/server/src/core/repositories.ts apps/server/src/platform/bun/sqlite-repositories.ts apps/server/src/api/dashboard.ts apps/server/test/user-state.test.ts apps/server/test/outbox.test.ts apps/server/test/maintenance.test.ts
git commit -S -m "feat: add local state and revisioned outbox"
```

### Task 9: Add the Emby-Compatible HTTP Surface

**Files:**
- Create: `apps/server/src/api/emby-schemas.ts`
- Create: `apps/server/src/api/emby.ts`
- Create: `apps/server/src/api/application.ts`
- Create: `apps/server/test/emby-auth.test.ts`
- Create: `apps/server/test/emby-catalog.test.ts`
- Create: `apps/server/test/emby-state.test.ts`

**Interfaces:**
- Consumes: `Auth`, `Federation`, `UserState`, `Playback`, and platform-neutral HTTP request/response services.
- Produces: Emby authentication, server identity, views, item list/search/detail, user-state, playback-report, and `/emby` alias routes required by captured SenPlayer behavior.

- [ ] **Step 1: Write protocol-shape tests from fixtures**

```ts
it("returns Emby list fields with local state overlaid", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const response = yield* app.request(authorizedGet("/Users/u/Items?ParentId=lib&StartIndex=0&Limit=20"))
    expect(response.status).toBe(200)
    const body = yield* response.json()
    expect(body).toMatchObject({
      Items: [{ Id: expect.any(String), Type: "Movie", UserData: { IsFavorite: true } }],
      StartIndex: 0,
      TotalRecordCount: expect.any(Number)
    })
  }))
})
```

Add fixtures/tests for public system identity, username/password authentication, token authentication, views, movie/series/season/episode details, query filters, media sources, count correction, unknown IDs, local watched/favorite/resume mutations, playback start/progress/stop, typed errors, request cancellation, and every observed `/emby` alias. Reject unknown API paths as JSON/non-HTML 404.

Add `/health` coverage proving the unauthenticated response reports runtime availability only, without database, upstream, user, token, or configuration details.

- [ ] **Step 2: Run the protocol tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- emby-auth.test.ts emby-catalog.test.ts emby-state.test.ts`

Expected: FAIL because the Emby router and schemas do not exist.

- [ ] **Step 3: Implement the smallest SenPlayer-required route set**

```ts
export interface ApplicationServices {
  readonly handleDashboard: (request: Request) => Effect.Effect<Response>
  readonly handleEmby: (request: Request) => Effect.Effect<Response>
  readonly handleDashboardAsset: (request: Request) => Effect.Effect<Response>
}

export const routeApplication = (request: Request): Effect.Effect<Response, never, ApplicationServices>
```

Route Dashboard API first, then exact Emby paths and aliases, then Dashboard assets, then ordinary 404. Decode request params and bodies with schemas before calling core services. Map internal failures to protocol-compatible status/body shapes without secrets. Overlay canonical local state on every DTO and never import upstream user state as authoritative.

- [ ] **Step 4: Verify protocol routes and unknown-path behavior**

Run: `bun --filter @oh-my-emby/server test -- emby-auth.test.ts emby-catalog.test.ts emby-state.test.ts`

Expected: PASS for the fixture contract; unknown Emby and Dashboard API routes never return HTML.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api apps/server/test/emby-auth.test.ts apps/server/test/emby-catalog.test.ts apps/server/test/emby-state.test.ts
git commit -S -m "feat: add emby compatible api"
```

### Task 10: Implement Playback, Image, and Subtitle Delivery

**Files:**
- Create: `apps/server/src/core/playback.ts`
- Create: `apps/server/src/core/resource-cache.ts`
- Modify: `apps/server/src/api/emby.ts`
- Create: `apps/server/test/playback.test.ts`
- Create: `apps/server/test/resources.test.ts`

**Interfaces:**
- Consumes: source media-version mappings, eligible-source checks, `UpstreamClient`, authentication principals, and bounded platform response cache.
- Produces: `Playback.getInfo`, `resolveVideoRedirect`, `resolveImage`, `resolveSubtitle`; `ResourceCache` Effect service; authenticated HTTP response handlers.

- [ ] **Step 1: Write redirect-only and bounded-resource tests**

```ts
it("redirects the selected version without reading video bytes", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const response = yield* app.request(streamRequest({ mediaSourceId: versionB.id }))
    expect(response.status).toBe(302)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("location")).toBe(versionB.signedUrl)
    expect(upstream.videoBodyReads).toBe(0)
  }))
})
```

Add cases for omitted-version stable fallback ordering, one upstream item with multiple media sources, obsolete generation, removed binding, per-version failure isolation, track indexes preserved in PlaybackInfo, no unsupported transcoding capability, authenticated token-bearing Location allowed only on media routes, URL not logged, image auth before cache lookup, registered-resource-only inputs, image MIME/size/deadline/header limits, subtitle identity by version plus stream index, supported text formats, and embedded/bitmap rejection.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test -- playback.test.ts resources.test.ts`

Expected: FAIL because playback/resource decisions do not exist.

- [ ] **Step 3: Implement version and video redirect decisions**

```ts
export type ResourceDecision =
  | { readonly _tag: "Redirect"; readonly location: URL }
  | { readonly _tag: "Proxy"; readonly request: RegisteredResourceRequest }

export interface PlaybackService {
  readonly getInfo: (canonicalId: string) => Effect.Effect<PlaybackInfo, PlaybackFailure>
  readonly resolveVideoRedirect: (input: VideoSelection) => Effect.Effect<URL, PlaybackFailure>
  readonly resolveImage: (input: ImageSelection) => Effect.Effect<ResourceDecision, ResourceFailure>
  readonly resolveSubtitle: (input: SubtitleSelection) => Effect.Effect<ResourceDecision, ResourceFailure>
}

export interface ResourceCacheService {
  readonly get: (key: string) => Effect.Effect<CachedResource | null, ResourceCacheError>
  readonly put: (key: string, response: CountedResource, expiresAtMs: number) => Effect.Effect<void, ResourceCacheError>
  readonly prune: (nowMs: number) => Effect.Effect<void, ResourceCacheError>
}
```

Stable fallback order is virtual-library source order, server ID, upstream item ID, media-source ID. Recheck source eligibility and configuration generation immediately before resolving. Rewrite every video entry point to the local authenticated stream route. Return the upstream capability URL only in `Location`; never cache or log it and never fetch its body.

- [ ] **Step 4: Implement counted auxiliary streaming**

Proxy only registered resources. Allowlist image and supported external text-subtitle MIME/format values, strip hop-by-hop/set-cookie/authentication headers, enforce 20 MiB image and 5 MiB subtitle limits while streaming, cancel on 15-second deadline, and keep the Effect scope alive through stream completion/cancellation. Cache bounded image payloads for six hours through `ResourceCache`; never store them in D1. The Workers adapter uses Cache API, while Bun uses a 256 MiB size-capped on-disk LRU under the data directory. Redirect only when the registered upstream resource is independently client-usable.

Run: `bun --filter @oh-my-emby/server test -- playback.test.ts resources.test.ts`

Expected: PASS; video body read count remains zero and auxiliary oversize streams terminate without partial cache entries.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/playback.ts apps/server/src/core/resource-cache.ts apps/server/src/api/emby.ts apps/server/test/playback.test.ts apps/server/test/resources.test.ts
git commit -S -m "feat: add redirect-only playback and resources"
```

### Task 11: Scaffold the Dashboard, Authentication Routes, and Application Shell

**Files:**
- Modify: `apps/dashboard/vite.config.ts`
- Create: `apps/dashboard/components.json`
- Modify: `apps/dashboard/index.html`
- Modify: `apps/dashboard/src/main.tsx`
- Create: `apps/dashboard/src/router.tsx`
- Create: `apps/dashboard/src/routes/__root.tsx`
- Create: `apps/dashboard/src/routes/setup.tsx`
- Create: `apps/dashboard/src/routes/login.tsx`
- Create: `apps/dashboard/src/routes/_authenticated.tsx`
- Create: `apps/dashboard/src/routes/_authenticated/index.tsx`
- Create: `apps/dashboard/src/lib/api-client.ts`
- Create: `apps/dashboard/src/lib/query-client.ts`
- Create: `apps/dashboard/src/lib/query-keys.ts`
- Create: `apps/dashboard/src/components/app-shell/app-shell.tsx`
- Create: `apps/dashboard/src/components/theme-provider.tsx`
- Create: `apps/dashboard/src/components/ui/` files actually used by setup/login/shell
- Create: `apps/dashboard/src/index.css`
- Create: `apps/dashboard/messages/en.json`
- Create: `apps/dashboard/messages/zh-CN.json`
- Create: `apps/dashboard/project.inlang/settings.json`
- Create: `apps/dashboard/test/auth-routing.test.tsx`
- Create: `apps/dashboard/test/i18n.test.ts`

**Interfaces:**
- Consumes: Task 2 `DashboardApi`, bootstrap/session endpoints, the approved shadcn preset, and React 19.
- Produces: generated route tree; singleton `QueryClient`; typed `apiClient`; `queryKeys`; setup/login/authenticated route boundary; responsive app shell; Paraglide messages.

- [ ] **Step 1: Generate the approved shadcn source in a disposable directory**

Run outside the repository:

```bash
tmp_dir="$(mktemp -d)"
cd "$tmp_dir"
bunx --bun shadcn@latest init --preset b59i69Ugb4 --template vite
```

Copy only `components.json`, the generated `src/index.css`, font/theme setup, and components used by this task into `apps/dashboard`. Do not copy a second package manager config or unused demo components. Set `base: "/dashboard/"`.

- [ ] **Step 2: Write route-boundary and locale-parity tests**

```tsx
it("redirects an uninitialized instance to setup", async () => {
  server.use(http.get("/api/dashboard/bootstrap", () => HttpResponse.json({ initialized: false })))
  const router = makeTestRouter("/dashboard/servers")
  await router.load()
  expect(router.state.location.pathname).toBe("/dashboard/setup")
})

it("keeps locale keys identical", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
})
```

Add route cases for initialized/no-session to login, authenticated shell entry, API unavailable distinct from login failure, logout cache clearing, and deep link resolution under `/dashboard`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun --filter @oh-my-emby/dashboard test -- auth-routing.test.tsx i18n.test.ts`

Expected: FAIL because the router, queries, and messages do not exist.

- [ ] **Step 4: Implement router, Query, API client, and shell**

Configure the Vite plugins in this order:

```ts
export default defineConfig({
  base: "/dashboard/",
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    paraglideVitePlugin({ project: "./project.inlang", outdir: "./src/paraglide" }),
    react()
  ]
})
```

Create the root with `createRootRouteWithContext<{ queryClient: QueryClient }>()`. Construct exactly one QueryClient and pass it to both Router context and `QueryClientProvider`; create the router with `basepath: "/dashboard"` and intent preloading. The authenticated layout `beforeLoad` calls `ensureQueryData` for `bootstrap` then `session` and throws typed redirects. Module services are the only code that runs Effect HttpApi client calls as Promises. A 401 removes all protected key families, refetches `session`, and lets the route boundary redirect.

Setup atomically creates the account, stores no password in Query/Form state after success, and resumes first-server setup for an authenticated zero-upstream instance. The shell provides keyboard-reachable sidebar/drawer navigation, title/breadcrumbs, language, theme, and logout. Every visible/ARIA string comes from Paraglide.

The setup screen displays the accepted first-visitor takeover risk before account submission and never claims a setup secret exists.

Run: `bun --filter @oh-my-emby/dashboard test -- auth-routing.test.tsx i18n.test.ts && bun --filter @oh-my-emby/dashboard build`

Expected: PASS; generated asset URLs begin with `/dashboard/`.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard
git commit -S -m "feat: scaffold dashboard shell and auth"
```

### Task 12: Build Server, Library, and System Dashboard Slices

**Files:**
- Create: `apps/dashboard/src/routes/_authenticated/servers.index.tsx`
- Create: `apps/dashboard/src/routes/_authenticated/servers.$id.tsx`
- Create: `apps/dashboard/src/routes/_authenticated/libraries.index.tsx`
- Create: `apps/dashboard/src/routes/_authenticated/libraries.$id.tsx`
- Create: `apps/dashboard/src/routes/_authenticated/system.tsx`
- Create: `apps/dashboard/src/modules/servers/` service, hook, form, list, and detail files
- Create: `apps/dashboard/src/modules/libraries/` service, hook, form, list, and detail files
- Create: `apps/dashboard/src/modules/system/` service, hook, status, and outbox files
- Create: `apps/dashboard/src/modules/auth/components/password-form.tsx`
- Modify: `apps/dashboard/src/lib/query-keys.ts`
- Modify: `apps/dashboard/messages/en.json`
- Modify: `apps/dashboard/messages/zh-CN.json`
- Create: `apps/dashboard/test/server-form.test.tsx`
- Create: `apps/dashboard/test/query-behavior.test.tsx`
- Create: `apps/dashboard/test/page-states.test.tsx`

**Interfaces:**
- Consumes: Task 11 app shell/client/query infrastructure and every DashboardApi control-plane endpoint.
- Produces: the approved Dashboard routes, forms, service query options/mutations, precise invalidation, visible-page health polling, and secret-safe diagnostics.

- [ ] **Step 1: Write form and Query behavior tests**

```tsx
it("preserves a configured password when the edit field stays empty", async () => {
  render(<ServerForm server={configuredServer} />)
  await user.clear(screen.getByLabelText(messages.server_password()))
  await user.click(screen.getByRole("button", { name: messages.save() }))
  expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({
    password: { _tag: "Preserve" }
  }))
})

it("invalidates only the saved server family", async () => {
  await saveServerMutation.mutateAsync(serverDraft)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.server(serverDraft.id) })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.servers })
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.libraries })
})
```

Add tests for explicit secret clear, save despite failed connection test, Effect Standard Schema field errors, accessible non-field alert, source-library discovery, disabled source binding, 30-second health polling only while visible, pending skeleton, actionable empty state, targeted retry error, stale versus missing health, safe outbox failure fields, password change, and no optimistic cache writes.

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `bun --filter @oh-my-emby/dashboard test -- server-form.test.tsx query-behavior.test.tsx page-states.test.tsx`

Expected: FAIL because the feature slices do not exist.

- [ ] **Step 3: Implement module services and TanStack Form composition**

Centralize keys exactly as approved:

```ts
export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  session: ["session"] as const,
  servers: ["servers"] as const,
  server: (id: string) => ["servers", id] as const,
  serverHealth: (id: string) => ["servers", id, "health"] as const,
  serverLibraries: (id: string) => ["servers", id, "libraries"] as const,
  libraries: ["libraries"] as const,
  library: (id: string) => ["libraries", id] as const,
  system: ["system"] as const,
  outboxFailures: ["system", "outbox-failures"] as const
}
```

Each module service exports stable `queryOptions` factories and mutation functions. Form validators use `Schema.toStandardSchemaV1` from the shared contract. Convert empty password to `Preserve`; only the dedicated clear confirmation sends `Clear`. Connection test and save remain separate mutations. Route files validate params/search, preload only prerequisites/detail, and render templates without network calls.

- [ ] **Step 4: Implement page states and verify UI behavior**

Use cards/simple lists, not a table abstraction. Every query renders pending, empty, failed, and successful states distinctly. Poll health with `refetchInterval: document.visibilityState === "visible" ? 30_000 : false` and re-evaluate on `visibilitychange`. System displays database/cache/outbox/upstream health and only typed non-secret outbox diagnostics. Add English and Simplified Chinese text for every new visible string and ARIA label.

Run: `bun --filter @oh-my-emby/dashboard test && bun --filter @oh-my-emby/dashboard typecheck && bun --filter @oh-my-emby/dashboard build`

Expected: PASS; locale parity holds and no response or rendered text contains configured secrets.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard
git commit -S -m "feat: add dashboard configuration flows"
```

### Task 13: Add the Cloudflare Workers/D1 Adapter

**Files:**
- Create: `apps/server/wrangler.jsonc`
- Create: `apps/server/worker-configuration.d.ts`
- Create: `apps/server/src/platform/workers/index.ts`
- Create: `apps/server/src/platform/workers/d1-repositories.ts`
- Create: `apps/server/src/platform/workers/assets.ts`
- Create: `apps/server/src/platform/workers/cache.ts`
- Create: `apps/server/vitest.config.workers.ts`
- Create: `apps/server/test/d1-repository.test.ts`
- Create: `apps/server/test/workers-routing.test.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: application/core services, `DB: D1Database`, `ASSETS: Fetcher`, Cache API, `ExportedHandler<Env>`, and shared migration files.
- Produces: Worker `fetch` and `scheduled` handlers; D1 repository layer; strict `/dashboard` assets/fallback; real D1 conformance test target.

- [ ] **Step 1: Add Wrangler config and generate binding types**

Use the exact config shape supported by Wrangler's schema:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "oh-my-emby",
  "main": "src/platform/workers/index.ts",
  "compatibility_date": "2026-09-20",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "PUBLIC_ORIGIN": "http://localhost:8787",
    "TRUSTED_PROXIES": ""
  },
  "assets": {
    "directory": "../dashboard/dist",
    "binding": "ASSETS",
    "html_handling": "none",
    "not_found_handling": "none",
    "run_worker_first": true
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "oh-my-emby",
    "migrations_dir": "migrations",
    "migrations_table": "schema_migrations"
  }],
  "triggers": { "crons": ["*/5 * * * *"] },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "redact_query_string": true
  }
}
```

Run: `bun --cwd apps/server x wrangler types`

Expected: generated `worker-configuration.d.ts` contains `DB` and `ASSETS`; no hand-written `Env` interface exists.

- [ ] **Step 2: Run the shared repository contract against D1 and verify failure**

Wire `repositoryContract(() => D1Repositories.layer(testEnv.DB))` through `@cloudflare/vitest-pool-workers` with isolated storage.

Run: `bun --filter @oh-my-emby/server test:workers -- d1-repository.test.ts`

Expected: FAIL because the D1 repository layer does not exist.

- [ ] **Step 3: Implement D1 transactions and Worker handlers**

Use D1 prepared statements and `batch()` with SQL-side generation/revision/lease predicates for each atomic repository command; never rely on an in-memory lock. The exported handler has no module-level request state:

```ts
export default {
  fetch(request, env, ctx) {
    return runWorkerRequest(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runWorkerMaintenance(controller.scheduledTime, env))
  }
} satisfies ExportedHandler<Env>
```

Await or return every Promise; do not destructure `ctx`. Core correctness remains database-backed and does not depend on `waitUntil()` completing indefinitely.

- [ ] **Step 4: Implement strict assets and platform integration tests**

For `/dashboard/*`, first request the exact prefix-stripped asset from `env.ASSETS`. Return `index.html` only for `GET`/`HEAD`, an HTML-accepting navigation, and no known static extension. Missing JS/CSS/images/maps/fonts, unsupported methods, API routes, Emby routes, and traversal attempts return non-HTML errors. Add tests for a `/dashboard/servers` deep-link refresh, unknown `/api/dashboard/*`, Worker Cron local entry, D1 migration application, and custom-port validation.

Run: `bun --filter @oh-my-emby/server test:workers && bun --cwd apps/server x wrangler deploy --dry-run`

Expected: D1 contract and routing tests pass; dry-run validates config and bundles without Node/Bun-only imports.

- [ ] **Step 5: Commit**

```bash
git add apps/server/wrangler.jsonc apps/server/worker-configuration.d.ts apps/server/vitest.config.workers.ts apps/server/src/platform/workers apps/server/test/d1-repository.test.ts apps/server/test/workers-routing.test.ts apps/server/package.json
git commit -S -m "feat: add workers and d1 runtime"
```

### Task 14: Add the Bun/SQLite Docker Adapter

**Files:**
- Create: `apps/server/src/platform/bun/index.ts`
- Modify: `apps/server/src/platform/bun/sqlite-repositories.ts`
- Create: `apps/server/src/platform/bun/assets.ts`
- Create: `apps/server/src/platform/bun/cache.ts`
- Create: `apps/server/test/bun-routing.test.ts`
- Create: `apps/server/test/bun-runtime.test.ts`
- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.dockerignore`
- Create: `docs/deployment/docker.md`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: application/core services, Bun HTTP and SQLite, dashboard `dist`, public-origin/trusted-proxy/data-dir configuration.
- Produces: one Bun listener and process-owned maintenance timer; traversal-safe static assets; Bun-only production container and health check.

- [ ] **Step 1: Write Bun routing and restart tests**

```ts
it("never turns a missing hashed asset into index.html", async () => {
  const response = await request("/dashboard/assets/missing-abc123.js", {
    headers: { accept: "text/html,*/*" }
  })
  expect(response.status).toBe(404)
  expect(response.headers.get("content-type")).not.toContain("text/html")
})
```

Add cases for deep links, HEAD navigation, POST deep link, path traversal, unknown API/Emby paths, migrations before listen, failed migration preventing listen, maintenance timer overlap, SQLite persistence across process restart, public-origin cookie behavior, trusted proxy allowlist, and localhost-only HTTP development.

- [ ] **Step 2: Run the Bun tests to verify they fail**

Run: `bun --filter @oh-my-emby/server test:bun -- bun-routing.test.ts bun-runtime.test.ts`

Expected: FAIL because the Bun entry point and asset adapter do not exist.

- [ ] **Step 3: Implement the Bun process lifecycle**

```ts
export const main = Effect.gen(function*() {
  const config = yield* RuntimeConfig
  yield* applyMigrations(config.sqlitePath)
  const server = yield* startBunServer(config)
  const maintenance = yield* scheduleMaintenance({ everyMs: 5 * 60_000, skipIfRunning: true })
  yield* Effect.addFinalizer(() => Effect.all([server.close, maintenance.cancel], { discard: true }))
  yield* Effect.never
})
```

Resolve assets under the built Dashboard root using a normalized relative path and verify the resolved path remains inside that root. Apply the same method/Accept/extension fallback predicate as Workers. Invoke `runMaintenance` every five minutes without overlapping calls; persistence leases handle restart recovery.

- [ ] **Step 4: Build and exercise the production image**

Use a multi-stage Dockerfile: tooling stage installs with the lockfile and builds Dashboard/server; final stage starts from an official pinned Bun image, copies only Bun runtime output, Dashboard assets, and migrations, runs as a non-root user, exposes one port, declares `/data`, and has no Node binary or proxy. `compose.yaml` mounts one named volume and requires `PUBLIC_ORIGIN` plus explicit trusted-proxy configuration.

Run:

```bash
docker build -t oh-my-emby:test .
docker run --rm oh-my-emby:test sh -c '! command -v node && command -v bun'
docker compose up -d
curl --fail http://127.0.0.1:3000/health
docker compose down
```

Expected: image builds; Node is absent; Bun is present; health returns 200; SQLite data survives a container restart performed inside the runtime test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/bun apps/server/test/bun-routing.test.ts apps/server/test/bun-runtime.test.ts apps/server/package.json Dockerfile compose.yaml .dockerignore docs/deployment/docker.md
git commit -S -m "feat: add bun sqlite docker runtime"
```

### Task 15: Add CI, Cross-Platform Acceptance, and SenPlayer Evidence

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `apps/server/test/cross-platform.test.ts`
- Create: `apps/server/test/ten-source-budget.test.ts`
- Create: `scripts/smoke-workers.sh`
- Create: `scripts/smoke-docker.sh`
- Create: `scripts/benchmark-pbkdf2.ts`
- Create: `docs/deployment/workers.md`
- Create: `docs/compatibility/senplayer.md`
- Create: `docs/compatibility/runtime.md`
- Create: `README.md`

**Interfaces:**
- Consumes: all completed workspace packages and both runtime artifacts.
- Produces: reproducible CI gates, cross-platform behavior proof, bounded ten-source evidence, deployment runbooks, and captured SenPlayer compatibility record.

- [ ] **Step 1: Write cross-platform acceptance tests**

```ts
describe.each([
  ["workers", workersHarness],
  ["docker", dockerHarness]
])("%s runtime", (_, harness) => {
  it("supports claim, server setup, deep-link routing, and secret-safe status", async () => {
    const app = await harness.startFresh()
    await expect(app.claim(ownerFixture)).resolves.toMatchObject({ authenticated: true })
    await expect(app.saveServer(serverFixture)).resolves.toMatchObject({ hasPassword: true })
    expect((await app.get("/dashboard/servers")).status).toBe(200)
    expect(await app.dumpPublicResponses()).not.toContain(serverFixture.password)
  })
})
```

Add parity cases for repository encoding/order, migrations, unknown API non-HTML 404, missing asset non-HTML 404, exact merge, partial upstream failure, local-state membership, outbox recovery after restart, and one private/non-cacheable video 302 with zero proxied bytes.

- [ ] **Step 2: Add the ten-source budget test and verify failure before harness wiring**

The fixture uses ten sources, duplicate-heavy 100-item pages, two slow sources, one transient failure, and media-source enrichment. Assert maximum four concurrent fetches, 100 public page size, 2,000 materialized rows, 100-row SQL writes, response bodies below 8 MiB, and no full-library cursor/scan call.

Run: `bun --filter @oh-my-emby/server test -- cross-platform.test.ts ten-source-budget.test.ts`

Expected: FAIL until both harnesses expose the same test interface and budget metrics.

- [ ] **Step 3: Implement CI and smoke scripts**

CI jobs run on the committed lockfile and include:

```yaml
jobs:
  static:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2
      - run: bun ci
      - run: bun run typecheck
      - run: bun run build
  test:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2
      - run: bun ci
      - run: bun run test
      - run: bun --filter @oh-my-emby/server test:workers
      - run: bun --filter @oh-my-emby/server test:bun
  docker:
    steps:
      - run: docker build -t oh-my-emby:ci .
      - run: ./scripts/smoke-docker.sh
```

Keep Workers deployment out of untrusted pull requests. The Workers runbook applies migrations with Wrangler before deploy activation, documents D1/database creation, public HTTPS, supported upstream host rules, Static Assets, Cron, custom ports, and secret commands. The Docker runbook documents TLS termination, `Secure` cookies, public origin, trusted proxies, data backup, LAN-upstream trust, and upgrade migrations.

For remote staging, `smoke-workers.sh --remote` creates an ephemeral D1 database, writes its returned ID and the explicit HTTPS staging origin into a temporary Wrangler config, runs `wrangler d1 migrations apply --remote`, deploys only after migration success, executes the smoke suite, and deletes the staging Worker/database during cleanup. The committed local config never supplies a production origin or database ID.

`scripts/benchmark-pbkdf2.ts` runs the configured 310,000 PBKDF2-SHA-256 iterations ten times, discards the first run, and reports p50/p95. Record Bun and deployed-Worker measurements in `docs/compatibility/runtime.md`. The release gate requires p95 below 250 ms on both; if a target misses, change the single stored iteration constant and rerun authentication tests plus both benchmarks before release.

- [ ] **Step 4: Capture real SenPlayer behavior and run the full gate**

Populate `docs/compatibility/senplayer.md` with the tested platform/build, timestamps, sanitized request sequence, required fields, observed `/emby` aliases, count increase/decrease and terminal empty-page behavior, version selection, PlaybackInfo, real stream request and 302, seeking, audio/subtitle selection, watched/resume reports, and explicit failures. Do not mark an unexecuted item as passing.

Run:

```bash
bun run check
bun --filter @oh-my-emby/server test:workers
bun --filter @oh-my-emby/server test:bun
WORKERS_STAGING_NAME=oh-my-emby-staging ./scripts/smoke-workers.sh --remote
./scripts/smoke-docker.sh
```

Expected: every automated gate exits 0; a freshly migrated remote staging Worker and the Docker image answer their HTTP smoke suites; SenPlayer evidence distinguishes observed passes, observed failures, and untested behavior. `smoke-workers.sh` defaults to local workerd for development and requires `--remote` plus an explicit staging name for release evidence.

- [ ] **Step 5: Commit**

```bash
git add .github scripts docs/deployment docs/compatibility README.md apps/server/test/cross-platform.test.ts apps/server/test/ten-source-budget.test.ts
git commit -S -m "test: add cross-platform acceptance gates"
```

## Final Verification Gate

Before claiming the MVP complete, run all of the following from a clean checkout:

```bash
bun --version
bun ci
bun run typecheck
bun run test
bun run build
bun --filter @oh-my-emby/server test:workers
bun --filter @oh-my-emby/server test:bun
bun --cwd apps/server x wrangler deploy --dry-run
docker build -t oh-my-emby:verify .
WORKERS_STAGING_NAME=oh-my-emby-staging ./scripts/smoke-workers.sh --remote
./scripts/smoke-docker.sh
git status --short
```

Expected: every command exits 0; `git status --short` is empty. Report unit/contract/integration counts separately from Workers runtime, Docker runtime, and real SenPlayer evidence. A successful build or CI run is not a substitute for runtime or client evidence.
