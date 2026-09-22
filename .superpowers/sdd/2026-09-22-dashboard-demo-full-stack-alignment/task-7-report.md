# Task 7 report — Server cards and route-controlled endpoint editor

## Result

`DONE_WITH_CONCERNS`

- Replaced all browser-facing `baseUrl` use with the Task 1 endpoint contracts. One Server now owns an ordered endpoint list with shared credentials, libraries, and User-Agent policy.
- Rebuilt the list with the generated shadcn Card composition. Cards show primary endpoint, aggregate health, endpoint count, catalog state, username, and UA policy. The generated Card recipe was not restyled; server cards and the add-server control use the same grid row and `min-h-52` layout height.
- Added the generated right-side inset Drawer at `38rem` desktop width with no swipe handle. `?new=true` owns create state and `/servers/$id` owns edit state; close/save return to `/servers`, while refresh and direct navigation preserve the Drawer.
- Added a readable responsive endpoint editor: separate labeled protocol/host and optional port/path rows, default `{ protocol: "http", host: "", port: null, path: "" }`, visible `8096` placeholder, and accessible add/remove/reorder actions.
- Added exactly three generated Field/RadioGroup UA choice cards (`fixed`, `client-preferred`, `passthrough`) with conditional fixed/fallback input.
- Preserved SecretPatch `Preserve` / `Set` / confirmed `Clear`. Public form state contains only `hasPassword`; no secret is read back.
- Kept connection testing separate from save and rendered endpoint results in configured order. Connection/save failures preserve the draft; save failures focus the error summary.
- Added typed loading, retryable error, missing-ID, delete-failure, and save-failure states with English/Simplified Chinese parity.
- Server mutations use exact Query invalidation for the list, selected detail, health, source libraries, System, and the existing Overview constituent keys. No client store or optimistic configuration write was added.

## TDD evidence

### RED

The required exact command was run first:

```sh
cd apps/dashboard
bun --bun vitest run test/server-form.test.tsx test/server-drawer.test.tsx test/query-behavior.test.tsx
```

It exited 1 before test collection because all three Vitest/jsdom workers failed with:

```text
TypeError: 'addEventListener' called on an object that is not a valid instance of EventTarget
```

Per the brief, the repository script was then used for runnable RED evidence:

```sh
cd apps/dashboard
bun run test -- test/server-form.test.tsx test/server-drawer.test.tsx test/query-behavior.test.tsx
```

Initial result: 14 expected failures and 7 passes. The failures showed no endpoint controls/defaults/reordering, no UA policy cards, no endpoint-specific errors/results, no route-controlled Drawer, and incomplete invalidation. Two query fixtures initially returned incomplete Task 1 response shapes; after correcting those test fixtures, the query assertions failed specifically on the missing health/source-library/System/Overview invalidations.

### GREEN

```sh
cd apps/dashboard
bun run test -- test/server-form.test.tsx test/server-drawer.test.tsx test/query-behavior.test.tsx
```

Result: 3 files, 21/21 tests passed with no warnings.

Coverage includes endpoint defaults/add/remove/reorder/validation, the three UA modes and conditional values, SecretPatch semantics, ordered test results, failed-operation draft retention, create/edit deep links, close navigation, typed missing IDs, and exact query invalidation.

## Fresh verification

- `cd apps/dashboard && bun run test`: PASS, 6 files and 61/61 tests.
- `cd apps/dashboard && bun run typecheck`: PASS.
- `cd apps/dashboard && bun run build`: PASS, Vite transformed 2,945 modules.
- `bunx oxlint apps/dashboard/src`: PASS with `shadcn/no-restyle` enabled.
- Impeccable detector, run once over `apps/dashboard/src/modules/servers`: PASS, returned `[]`; it was not rerun.
- `git diff --check`: PASS.
- Targeted `rg` found no Server-module/test use of the removed `baseUrl` DTO field or user-facing Provider terminology.

## Self-review

- Confirmed the Drawer is inset, right-sided, route-owned, and uses the generated default `showSwipeHandle={false}` behavior.
- Confirmed generated shadcn primitives were not edited. Domain composition uses only generated Card, Drawer, Scroll Area, Input Group, Field, Radio Group, Select, Switch, Button Group, Badge, Alert, and Button exports.
- Confirmed the endpoint editor wraps into labeled controls on narrow screens instead of compressing protocol, host, port, and path into one row.
- Confirmed cards and the add control share the same equal-row/minimum-height rule, avoiding the prototype's mismatched apparent edge.
- Confirmed Server form, route, query, error, and locale tests exercise real components and router/query providers rather than asserting mocked UI.
- Deliberately skipped a new client store, handwritten primitives, Tabs, optimistic writes, provider terminology, a new API shape, and Task 8 Library/System work.

## Concern

- The exact `bun --bun vitest` command still cannot collect jsdom tests because of the existing Bun/Vitest worker EventTarget incompatibility. The repository-owned `bun run test` path is green for both the focused tests and the full Dashboard suite. No browser screenshot pass was requested or performed, so the report makes no browser-render claim.
