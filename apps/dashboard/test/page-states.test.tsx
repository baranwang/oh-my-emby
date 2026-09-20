import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { OutboxFailureView, ServerView, SourceLibraryView } from "@oh-my-emby/contracts"
import { describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>
  }
})

import { SourceBindings } from "../src/modules/libraries/components/library-form.js"
import { ServerHealthStatus } from "../src/modules/servers/components/server-detail.js"
import { ServerList } from "../src/modules/servers/components/server-list.js"
import { OutboxFailures } from "../src/modules/system/components/outbox-failures.js"
import { m } from "../src/paraglide/messages.js"

const server = {
  id: "server-1",
  name: "Home",
  baseUrl: "https://emby.example.com",
  username: "alice",
  hasPassword: true,
  userAgent: "SenPlayer/1",
  enabled: true,
  verifiedCatalogId: "catalog-1",
  generation: 1,
  health: "healthy"
} as ServerView

describe("server page states", () => {
  it("renders a distinct pending skeleton", () => {
    const markup = renderToStaticMarkup(
      <ServerList state="pending" servers={[]} onRetry={vi.fn()} onCreate={vi.fn()} />
    )
    expect(markup).toContain(`aria-label="${m.servers_loading()}"`)
    expect(markup).toContain("data-slot=\"skeleton\"")
  })

  it("renders an actionable empty state", () => {
    const markup = renderToStaticMarkup(
      <ServerList state="success" servers={[]} onRetry={vi.fn()} onCreate={vi.fn()} />
    )
    expect(markup).toContain(m.servers_empty())
    expect(markup).toContain(m.add_server())
  })

  it("renders a targeted retry state", () => {
    const markup = renderToStaticMarkup(
      <ServerList state="error" servers={[]} onRetry={vi.fn()} onCreate={vi.fn()} />
    )
    expect(markup).toContain(m.servers_load_failed())
    expect(markup).toContain(m.retry())
  })

  it("renders successful server content", () => {
    const markup = renderToStaticMarkup(
      <ServerList state="success" servers={[server]} onRetry={vi.fn()} onCreate={vi.fn()} />
    )
    expect(markup).toContain("Home")
    expect(markup).toContain("https://emby.example.com")
  })
})

it("distinguishes missing health from stale health", () => {
  const missing = renderToStaticMarkup(
    <ServerHealthStatus health={{ serverId: server.id, health: "unknown", lastSuccessAtMs: null }} nowMs={120_000} />
  )
  const stale = renderToStaticMarkup(
    <ServerHealthStatus health={{ serverId: server.id, health: "degraded", lastSuccessAtMs: 1 }} nowMs={120_000} />
  )

  expect(missing).toContain(m.health_missing())
  expect(stale).toContain(m.health_stale())
  expect(stale).not.toContain(m.health_missing())
})

it("renders discovered and disabled source bindings explicitly", () => {
  const source = {
    id: "source-1",
    serverId: "server-1",
    name: "Movies",
    mediaType: "movies"
  } as SourceLibraryView
  const markup = renderToStaticMarkup(
    <SourceBindings
      groups={[{ server, state: "success", sources: [source] }]}
      mediaType="movies"
      bindings={[{ serverId: server.id, sourceLibraryId: source.id, enabled: false }]}
      onToggle={vi.fn()}
    />
  )

  expect(markup).toContain("Movies")
  expect(markup).toContain(m.source_binding_disabled())
  expect(markup).toContain('type="checkbox"')
  expect(markup).not.toContain("checked=\"\"")
})

it("keeps configured bindings visible when their source server is unavailable", () => {
  const source = {
    id: "source-1",
    serverId: "server-1",
    name: "Movies",
    mediaType: "movies"
  } as SourceLibraryView
  const markup = renderToStaticMarkup(
    <SourceBindings
      groups={[{ server: { ...server, enabled: false }, state: "unavailable", sources: [source] }]}
      mediaType="movies"
      bindings={[{ serverId: server.id, sourceLibraryId: source.id, enabled: true }]}
      onToggle={vi.fn()}
    />
  )

  expect(markup).toContain(m.source_libraries_unavailable())
  expect(markup).toContain("Movies")
  expect(markup).toContain(m.source_binding_enabled())
})

it("renders only typed, non-secret outbox failure diagnostics", () => {
  const failure = {
    serverId: "server-1",
    code: "upstream_rejected",
    failedAtMs: 1_000,
    attemptCount: 2,
    nextAttemptAtMs: 2_000,
    uncertainSinceMs: null
  } as OutboxFailureView
  const markup = renderToStaticMarkup(<OutboxFailures failures={[failure]} />)

  expect(markup).toContain("server-1")
  expect(markup).toContain("upstream_rejected")
  expect(markup).toContain("2")
  expect(markup).not.toContain("password")
  expect(markup).not.toContain("token")
})
