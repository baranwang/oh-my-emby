# Dashboard Frontend Design

Date: 2026-09-20

Parent architecture: [Emby Aggregation Architecture Design](./2026-09-20-emby-aggregation-architecture-design.md)

## Status

Approved design for the first Dashboard release. This document defines frontend architecture only; it does not authorize product implementation beyond the agreed Dashboard boundary.

## Context

oh-my-emby is a single-user, self-hosted Emby-compatible aggregation service. The same repository must produce a Cloudflare Workers/D1 deployment and a Docker/Bun/SQLite deployment. Both variants expose the same Emby-compatible API and the same browser Dashboard.

The repository layout remains:

```text
apps/
  server/
  dashboard/
packages/
  contracts/
```

The Dashboard is a client-rendered React SPA. It has no SSR and does not implement a second media browser. Its job is to initialize the instance, configure upstream Emby servers and virtual media libraries, and expose operational status.

## Goals

- Provide one responsive configuration console for Workers and Docker deployments.
- Use shadcn/ui source components and the approved preset as the visual source of truth.
- Use TanStack Router for URL state and route boundaries.
- Use TanStack Query for all server state.
- Use TanStack Form for all editable forms.
- Reuse Effect v4 schemas and HttpApi contracts across the server and browser.
- Ship Simplified Chinese and English from the first release.
- Preserve secure browser session semantics while sharing the one product identity with Emby clients.

## Non-goals

- SSR, React Server Components, or a second web server for the Dashboard.
- Browsing, searching, or playing the aggregated media catalog in the Dashboard.
- SSE or WebSocket status updates.
- A standalone design-system package.
- A standalone i18n package.
- TanStack Table until a page has a real sorting, filtering, or pagination requirement.
- Optimistic writes in the first release.
- Multiple local users, roles, or administrators.

## URL ownership

| Prefix | Owner | Behavior |
| --- | --- | --- |
| `/dashboard/*` | Dashboard static assets and SPA | Deep links fall back to Dashboard `index.html`. |
| `/api/dashboard/*` | Dashboard HttpApi | JSON or typed HTTP errors only; never SPA fallback. |
| Emby-native paths | Emby-compatible server | Remain at their protocol-defined paths. |

Vite uses `base: "/dashboard/"` so generated asset URLs work in both deployments.

## Route tree

```text
/dashboard/setup
/dashboard/login
/dashboard/
/dashboard/servers
/dashboard/servers/$id
/dashboard/libraries
/dashboard/libraries/$id
/dashboard/system
```

`/setup` and `/login` render outside the authenticated application shell. The authenticated routes share a responsive shell with Overview, Servers, Libraries, and System navigation.

The setup flow creates the only local username and password, then configures the first upstream Emby server. Virtual media library creation remains on its dedicated page rather than being embedded in setup.

The account claim is the atomic initialization boundary. Once it commits, the instance is initialized and the browser receives an authenticated session. If first-server configuration fails, setup resumes as that authenticated user with zero upstreams; the instance never becomes claimable again.

## Source organization

The structure follows the useful boundaries in aio-proxy while removing package and directory overhead that this smaller Dashboard does not need:

```text
apps/dashboard/src/
  routes/                    # Thin TanStack Router declarations
  modules/
    auth/
    setup/
    servers/
    libraries/
    system/
      services/              # HttpApi client calls, queryOptions, mutation functions
      hooks/                 # Query and Form composition
      components/            # Reusable domain UI
      templates/             # Page assembly
      lib/                   # Pure domain logic
  components/
    ui/                      # shadcn-managed source
    app-shell/               # Shared navigation shell
  lib/
    api-client.ts
    query-client.ts
    query-keys.ts
  paraglide/                 # Generated localization output
  index.css                  # Approved preset tokens
```

Directories are created only when they contain code. Route files validate params and search state, run route prerequisites, and render module templates. Network calls never live in route files or React components.

Cross-module code belongs in `src/lib` or `src/components`. A domain module must not import another domain module's private implementation.

## shadcn/ui and visual tokens

The approved preset was generated in an isolated temporary Vite project with:

```bash
bunx --bun shadcn@latest init --preset b59i69Ugb4 --template vite
```

The command resolved shadcn `4.21.0` on 2026-09-20 and produced these relevant settings:

```json
{
  "style": "base-nova",
  "rsc": false,
  "tailwind": {
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "menuColor": "default-translucent",
  "menuAccent": "subtle"
}
```

The generated `src/index.css` is the token source of truth. It supplies the light and dark OKLCH palettes, semantic background/foreground/card/popover/primary/secondary/muted/accent/destructive/border/input/ring/sidebar/chart tokens, a base radius of `0.625rem`, and Noto Sans Variable plus Noto Serif Variable.

Implementation copies that approved output into the Dashboard and commits it. It does not reinterpret the preset into a second token layer. Product-specific status displays use existing semantic tokens plus icons and text; color is never their only signal.

shadcn components live directly under `src/components/ui`. They are repository-owned source files. Components are added only when a page uses them, and equivalent controls are not wrapped in one-off lookalikes.

The generated theme provider supplies light, dark, and system modes. The application exposes an accessible theme control in the shell.

## Application shell

The shell uses the shadcn Sidebar pattern:

- collapsible sidebar on desktop;
- drawer navigation on narrow screens;
- visible page title and breadcrumbs in the content area;
- language, theme, and logout actions in the shell;
- keyboard focus order, visible focus rings, labels, and error associations preserved by the shadcn/Base UI primitives.

Server and library collections use cards or simple lists. A table abstraction is added only when the product gains a real data-grid requirement.

## Shared API contract

`packages/contracts` owns an Effect v4 `HttpApi` named `DashboardApi`, its request and response schemas, and typed public errors. The Server implements that contract. The Dashboard creates its client with Effect `HttpApiClient` and a browser fetch layer pointed at `/api/dashboard`.

Module services are the only browser code allowed to call the generated client. They run client Effects as Promises for TanStack Query and decode every successful response through the shared schema. No generated OpenAPI client and no parallel handwritten DTOs are maintained.

The contract covers these resource families:

- instance initialization and session status;
- login and logout;
- current user password changes;
- upstream server create, read, update, delete, health, and connection test;
- upstream source-library discovery with stable IDs and media types;
- virtual library create, read, update, and delete;
- system/runtime status, outbox depth, and typed read-only outbox failure details safe for display.

## Router and authentication boundary

TanStack Router uses file-based routes and the Vite router plugin with automatic code splitting. The router base path is `/dashboard`, intent preloading is enabled, and the router context contains the single `QueryClient`.

The authenticated layout's `beforeLoad` resolves initialization and session queries:

1. An uninitialized instance redirects to `/setup`.
2. An initialized instance without a valid browser session redirects to `/login`.
3. An authenticated session may enter the application shell.

The one local username and password are shared product identity. An Emby client exchanges them for an Emby-compatible token. The Dashboard exchanges them for an opaque database-backed browser session.

The session cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`. The database stores only a hash of the random session token. Sessions expire after seven days of inactivity and roll forward while active. Logout revokes the current session; changing the password revokes all sessions. Mutating Dashboard requests also require a valid same-origin `Origin` check.

Production Dashboard access requires the configured public HTTPS origin on both Workers and Docker. Plain HTTP is limited to explicit localhost development. Origin checks and secure-request detection use that configured origin and an explicit trusted-proxy policy, never arbitrary forwarded headers.

The user explicitly accepted unauthenticated first-visitor ownership: while the instance is uninitialized, the first public visitor may create the sole account. This permits hostile takeover of a newly deployed public instance. The setup screen and deployment documentation must state this risk plainly. The implementation must not imply that the flow is protected by a setup secret.

## Query ownership

There is exactly one browser `QueryClient`. Server state is not duplicated into React Context, component stores, or Form state.

All query keys are declared centrally in `src/lib/query-keys.ts`:

```text
bootstrap
session
servers
server(id)
serverHealth(id)
serverLibraries(id)
libraries
library(id)
system
outboxFailures
```

Each module service exports stable `queryOptions` factories and mutation functions. Route loaders use `ensureQueryData` only for route prerequisites and initial detail data. Templates consume the same options through Query hooks, allowing Query to deduplicate requests.

Health state polls every 30 seconds only while its page is visible. Other resources use ordinary staleness and explicit invalidation. Mutations invalidate the narrowest affected key family after success. The first release does not optimistically mutate cached configuration.

A session-expired response clears protected cached data, refreshes the session query, and lets the router redirect to `/login`.

## Forms and validation

Every editable form uses TanStack Form. Shared Effect Schemas are converted with `Schema.toStandardSchemaV1` and passed to Form validators, so client validation and wire validation do not diverge. The server remains authoritative.

On submit:

1. TanStack Form validates the draft.
2. A TanStack Query mutation calls the module service.
3. Typed server field errors are assigned to their fields with the Form error map.
4. Non-field errors render in an accessible form-level alert.
5. Successful writes invalidate the affected Query keys and return to the relevant detail or list state.

Connection testing and saving an upstream server are separate mutations. A failed test is a warning and does not prevent saving an intentionally offline or not-yet-routable server.

Upstream passwords are write-only. Detail responses expose only whether a password is configured. On edit, an empty password field means preserve the existing value. A separate explicit clear action removes it. The same rule applies to any future secret field.

## Internationalization

Paraglide JS is compiled inside `apps/dashboard`; it is not a workspace package. Source messages are:

```text
messages/en.json
messages/zh-CN.json
```

Locale resolution order is:

```text
localStorage -> preferredLanguage -> baseLocale(en)
```

A user's manual selection persists in local storage. The runtime updates the document language when the locale changes. All visible natural-language copy, validation messages, empty states, errors, success messages, page titles, and ARIA labels come from Paraglide messages. Protocol names, IDs, URL paths, query keys, and other deliberately untranslated identifiers may remain literals.

A parity test prevents one locale from silently missing message keys.

## Error and loading states

Each page distinguishes:

- pending data, rendered with a stable skeleton matching the final layout;
- empty data, rendered as an action-oriented empty state;
- failed data, rendered as an error with a targeted retry action;
- stale upstream health, rendered separately from an empty or deleted server;
- unauthorized state, handled by the root authentication boundary;
- Dashboard API unavailable, rendered as an application-level unavailable state rather than a login failure.

The UI never reports a failed request as an empty collection.

## Deployment integration

### Cloudflare Workers

Wrangler binds the Dashboard build output as Static Assets with Worker-first routing and `html_handling: "none"`. Requests execute the Worker first so dynamic and Emby-compatible routes retain application control.

The Worker routing order is:

1. handle `/api/dashboard/*` with `DashboardApi`;
2. handle Emby-compatible paths with the virtual server;
3. for `/dashboard/*`, ask the assets binding for the exact prefix-stripped asset with Static Assets HTML canonicalization disabled;
4. return Dashboard `index.html` only for `GET` or `HEAD` navigation requests that accept HTML and do not target a known static-file extension;
5. return an ordinary 404 for every other unknown path.

Worker-first routing is explicit. Missing JavaScript, CSS, images, maps, fonts, unsupported methods, API routes, and Emby routes never fall back to HTML. The Worker serves the intended index body without exposing an internal prefix-stripped canonical redirect. This avoids a global `not_found_handling: "single-page-application"` rule that could turn API or asset 404 responses into HTML.

### Docker/Bun

The production image builds the Dashboard first and copies its output into the Bun server image. The Bun platform adapter serves the same files under `/dashboard/*` and applies the same method-, Accept-, and extension-aware `index.html` fallback. Asset path resolution is traversal-safe. No Node.js runtime and no second web server are added.

Hashed assets are cacheable as immutable. `index.html` is not immutable so a deployment cannot strand clients on obsolete asset names.

## Testing and acceptance

The smallest behavior-level test set for this architecture covers:

- shared Dashboard request and response schema decoding;
- initialization, login, and authenticated-route redirects;
- atomic first claim and resumable zero-upstream setup;
- seven-day rolling session expiry and revocation behavior at the server boundary;
- server form validation through Effect Standard Schema;
- write-only secret preserve and explicit-clear semantics;
- separate test-connection and save mutations;
- targeted Query invalidation after a mutation;
- visible-page-only health polling;
- upstream source-library discovery and secret-safe outbox diagnostics;
- English and Simplified Chinese message-key parity;
- a `/dashboard/servers` deep-link refresh in Workers and Docker;
- missing hashed assets and non-navigation methods remaining non-HTML errors;
- an unknown `/api/dashboard/*` path remaining a non-HTML 404 in Workers and Docker.

The Dashboard build must produce identical public URLs for both deployment artifacts. Runtime verification is separate from a successful build: each deployment target must be started and exercised against its real Server routes.

## Deliberate simplifications

- No separate UI or i18n workspace package; add one only when another application consumes it.
- No table library; add it when a real table needs sorting, filtering, or pagination.
- No state store; add one only for cross-route client-only state that cannot live in the URL or owning component.
- No realtime status channel; replace visible-page polling only when measured operational needs justify it.
- No protected setup claim; this is an explicitly accepted security risk, not an accidental omission.
