# Task 6 report — Production shadcn shell and actionable Overview

## Result

`DONE_WITH_CONCERNS`

- Installed the required shadcn primitives with the exact Bun CLI command. The first invocation generated the registry files before stopping at the existing `label.tsx` prompt; the repeated exact invocation preserved that existing Label and created the remaining four files. The final CLI-owned set adds Badge, Button Group, Card, Drawer, Dropdown Menu, Field, Input Group, Radio Group, Scroll Area, Select, Separator, Switch, and the Input Group's generated Textarea dependency. No generated recipe was hand-edited or copied from `.design`.
- Replaced the Sidebar footer logout button with the authenticated username menu. Password change and logout now exist only in that menu; password change opens an accessible generated Drawer. The header retains navigation/breadcrumb semantics but no longer contains language, theme, logout, or a replacement control strip.
- Added `OverviewPage`, derived directly from the existing servers, virtual libraries, system, and outbox-failures Query options. It has distinct loading/error states, one next-step setup action, non-color-only exception rows linked to their corrective route, and one compact healthy state with no metric/Card wall.
- Removed the duplicate password form from System. Language and theme were not moved there because that is Task 8.
- Restored the approved local Noto Sans Variable / Noto Serif Variable foundation while preserving the committed OKLCH tokens and `0.625rem` radius.
- Added English/Simplified Chinese copy and parity/non-empty tests.

## TDD evidence

### RED

After the tests were added and before the implementation, the runnable repository test script reported 9 expected failures and 18 passes:

```sh
cd apps/dashboard
bun run test -- test/page-states.test.tsx test/i18n.test.ts
```

The failures proved that the header still contained a language select, the Sidebar footer had no username menu, all five Overview states were absent, and both locales lacked the new shell/Overview messages. One existing Server-list assertion was initially disturbed by moving the shared fixture to the new endpoint shape; the fixture retained its legacy display field so Task 6 did not absorb Task 7's Server-page migration.

The brief's exact Bun-runtime command was also executed:

```sh
cd apps/dashboard
bun --bun vitest run test/page-states.test.tsx test/i18n.test.ts
```

It exited 1 before executing tests because Vitest/jsdom workers failed with `TypeError: 'addEventListener' called on an object that is not a valid instance of EventTarget`. `--pool=threads` produced the same pre-test runtime failure. The package script above is the executable test evidence.

### GREEN

```sh
cd apps/dashboard
bun run test -- test/page-states.test.tsx test/i18n.test.ts
```

Result: 2 files, 27/27 tests passed.

Coverage includes:

- header controls absent plus username-menu password/logout actions;
- pending and retryable error states;
- zero-server setup action;
- degraded server, unusable virtual-library, and failed-sync corrective links;
- compact healthy state without shadcn Card output; and
- identical, non-empty shell/Overview locale entries.

## Verification

- `cd apps/dashboard && bun run build`: PASS; Vite transformed 2,850 modules and emitted the Noto font assets.
- `bunx oxlint apps/dashboard/src`: PASS with `shadcn/no-restyle` enabled for product consumers. Following the lint package's documented adoption pattern, CLI-owned `components/ui` is excluded from that consumer rule; generated recipes remain authoritative. The one pre-existing consumer restyle moved `truncate` from Label to a plain wrapper.
- Impeccable mechanical detector over all changed UI targets: PASS, returned `[]`.
- `git diff --check`: PASS.
- `bun.lock`: unchanged; the required dependencies were already installed.

### Staged Task 7 failures

`cd apps/dashboard && bun run typecheck` exits 1 with six diagnostics, all in unchanged Task 7 files:

- `src/modules/servers/components/server-form.tsx`: five diagnostics because the legacy form still reads/writes `baseUrl` and does not construct `endpoints` / `userAgentPolicy`.
- `src/modules/servers/components/server-list.tsx`: one diagnostic because the legacy card still renders `server.baseUrl`.

The full Dashboard suite reports 49/57 passing. Its eight failures are the same staged mismatch: three legacy query-behavior fixtures submit a `ServerInput` without `endpoints`, and five legacy Server-form tests exercise the old `baseUrl` form. Task 6 did not change those production/test files because the brief assigns the Server form/drawer migration to Task 7.

## Self-review

- Confirmed there is no Overview API, query key, mutation, duplicated server state, or prototype mock state. The route only prefetches the four existing Query options consumed by `OverviewPage`.
- Confirmed usable-library derivation reuses the current Dashboard eligibility rule: an enabled binding on an enabled healthy Server. Disabled libraries and intentionally disabled Servers do not become false alarms.
- Confirmed every exception carries text in addition to icon/color and links to Servers, Virtual Libraries, or System. Loading has a named skeleton, the error is an alert with one retry action, and generated interactive primitives retain their keyboard behavior.
- Confirmed password/logout usage is scoped to the Sidebar account menu; System no longer renders account controls. Language/theme do not appear in the shell header.
- Confirmed generated shadcn files were not restyled and `.design/dashboard-prototype` was used only as an information/interaction reference.
- Confirmed no remote deployment, real Emby client, or upstream-health claim is made.

## Concerns

1. Dashboard typecheck and the full suite remain staged red on the unchanged legacy Server UI/fixtures described above; Task 7 must migrate them to ordered endpoints before the package can be globally green.
2. No browser screenshot evidence was produced. The installed `agent-browser` binary lacks the skill-required `skills get` command, so the browser workflow could not be loaded safely. Build, component-render tests, responsive composition classes, shadcn lint, and the Impeccable detector are verified; this report does not present them as browser evidence.

## Fix round — setup state no longer hides exceptions

### RED

Added a regression covering a degraded Server and failed synchronization while no virtual libraries exist. Before the fix, the focused suite reported 1 failure and 27 passes: the mixed state returned only the library setup screen instead of showing the actionable exceptions first.

### GREEN

The Overview now derives exceptions before choosing its setup presentation. A clean empty state is unchanged; when exceptions and incomplete setup coexist, exceptions render first and the relevant setup action remains available below them.

The focused suite reports 28/28 passing. `bun run build`, `bunx oxlint apps/dashboard/src`, and `git diff --check` pass. The full Dashboard suite reports 50/58 passing, with the same eight staged Task 7 failures: three legacy query-behavior inputs omit `endpoints`, and five Server-form tests still exercise `baseUrl`. Typecheck retains the same six Task 7 diagnostics (five in `server-form.tsx`, one in `server-list.tsx`).

### Self-review

- Confirmed exception derivation is shared by setup, healthy, and attention states rather than duplicated in a special-case branch.
- Confirmed zero-Server and zero-library clean setup screens retain their original single action.
- Confirmed mixed setup/exception states keep the corrective exception links ahead of the setup action.
- Confirmed the healthy layout and Card-free presentation are unchanged.
- Kept the Password Drawer minor explicitly deferred and did not absorb Task 7's Server migration.
