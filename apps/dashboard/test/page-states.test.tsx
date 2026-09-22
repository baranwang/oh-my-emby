import { act, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  OutboxFailureView,
  ServerView,
  SourceLibraryView,
  SystemStatusView,
  VirtualLibraryView
} from "@oh-my-emby/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
    useNavigate: () => vi.fn(),
    useRouter: () => ({ invalidate: vi.fn() }),
    useRouterState: () => "/dashboard/"
  }
})

import { AppShell } from "../src/components/app-shell/app-shell.js"
import { ThemeProvider } from "../src/components/theme-provider.js"
import { queryKeys } from "../src/lib/query-keys.js"
import { LibraryForm, SourceBindings } from "../src/modules/libraries/components/library-form.js"
import { LibrariesPage } from "../src/modules/libraries/libraries-page.js"
import { OverviewPage } from "../src/modules/overview/overview-page.js"
import { ServerDetailPage, ServerHealthStatus } from "../src/modules/servers/components/server-detail.js"
import { ServerList } from "../src/modules/servers/components/server-list.js"
import { OutboxFailures } from "../src/modules/system/components/outbox-failures.js"
import { m } from "../src/paraglide/messages.js"

const server = {
  id: "server-1",
  name: "Home",
  endpoints: [{
    id: "endpoint-1",
    protocol: "https",
    host: "emby.example.com",
    port: null,
    path: "",
    displayUrl: "https://emby.example.com/",
    verifiedCatalogId: "catalog-1",
    health: "healthy",
    lastSuccessAtMs: 1
  }],
  username: "alice",
  hasPassword: true,
  userAgentPolicy: "fixed",
  userAgent: "SenPlayer/1",
  enabled: true,
  verifiedCatalogId: "catalog-1",
  generation: 1,
  health: "healthy"
} as unknown as ServerView

const source = {
  id: "source-1",
  serverId: "server-1",
  name: "Movies",
  mediaType: "movies"
} as SourceLibraryView

const library = {
  id: "library-1",
  name: "Films",
  mediaType: "movies",
  sources: [{
    serverId: "server-1",
    sourceLibraryId: "source-1",
    sourceLibraryName: "Movies",
    enabled: true
  }],
  enabled: true
} as VirtualLibraryView

const system = {
  database: "healthy",
  cacheEntries: 0,
  maintenanceLastRunAtMs: null,
  outboxPending: 0,
  outboxFailed: 0,
  outboxUncertain: 0,
  upstreamHealthy: 1,
  upstreamDegraded: 0,
  upstreamUnknown: 0
} as SystemStatusView

const mounted: Array<{ container: HTMLDivElement; root: Root }> = []

const render = async (element: ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const view = { container, root }
  mounted.push(view)
  await act(async () => root.render(element))
  return view
}

const unmount = async (view: (typeof mounted)[number]) => {
  const index = mounted.indexOf(view)
  if (index !== -1) mounted.splice(index, 1)
  await act(async () => view.root.unmount())
  view.container.remove()
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  status
})

const buttonByName = (container: HTMLElement, name: string) => {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(name))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`)
  return button
}

const change = async (control: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(control, value)
    control.dispatchEvent(new Event("input", { bubbles: true }))
    control.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted[0]!)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const overviewClient = (data?: {
  readonly servers?: ReadonlyArray<ServerView>
  readonly libraries?: ReadonlyArray<VirtualLibraryView>
  readonly system?: SystemStatusView
  readonly failures?: ReadonlyArray<OutboxFailureView>
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  if (data?.servers) queryClient.setQueryData(queryKeys.servers, data.servers)
  if (data?.libraries) queryClient.setQueryData(queryKeys.libraries, data.libraries)
  if (data?.system) queryClient.setQueryData(queryKeys.system, data.system)
  if (data?.failures) queryClient.setQueryData(queryKeys.outboxFailures, data.failures)
  return queryClient
}

const renderOverview = (queryClient: QueryClient) => render(
  <QueryClientProvider client={queryClient}><OverviewPage /></QueryClientProvider>
)

describe("authenticated shell", () => {
  it("keeps header preferences out and exposes account actions from the Sidebar footer username menu", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })))
    const queryClient = overviewClient()
    queryClient.setQueryData(queryKeys.session, { authenticated: true, username: "owner" })
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppShell>Dashboard</AppShell>
        </ThemeProvider>
      </QueryClientProvider>
    )

    expect(view.container.querySelector("header select")).toBeNull()
    const account = buttonByName(view.container, "owner")
    expect(account.closest('[data-slot="sidebar-footer"]')).not.toBeNull()
    await act(async () => account.click())
    expect(document.body.textContent).toContain(m.change_password())
    expect(document.body.textContent).toContain(m.logout())
  })
})

describe("Overview states", () => {
  it("renders a distinct loading state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
    const view = await renderOverview(overviewClient())

    expect(view.container.querySelector('[aria-label="Loading overview"]')).not.toBeNull()
  })

  it("renders one actionable error state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ _tag: "Internal", requestId: "request-1" }, 500)))
    const view = await renderOverview(overviewClient())
    await act(async () => { await vi.waitFor(() => expect(view.container.textContent).toContain("Overview could not be loaded.")) })

    expect(buttonByName(view.container, m.retry())).toBeInstanceOf(HTMLButtonElement)
  })

  it("renders the next setup action when no server exists", async () => {
    const view = await renderOverview(overviewClient({ servers: [], libraries: [], system, failures: [] }))

    expect(view.container.textContent).toContain("Add your first server")
    expect(view.container.textContent).toContain(m.add_server())
  })

  it("keeps exceptions ahead of the library setup action when no library exists", async () => {
    const failure = {
      serverId: server.id,
      code: "DeliveryFailed",
      failedAtMs: 1,
      attemptCount: 2,
      nextAttemptAtMs: null,
      uncertainSinceMs: null
    } as OutboxFailureView
    const view = await renderOverview(overviewClient({
      servers: [{ ...server, health: "degraded" } as ServerView],
      libraries: [],
      system: { ...system, upstreamHealthy: 0, upstreamDegraded: 1, outboxFailed: 1 },
      failures: [failure]
    }))

    expect(view.container.textContent).toContain("Needs attention")
    expect(view.container.textContent).toContain("Home")
    expect(view.container.textContent).toContain("State synchronization needs attention")
    expect(view.container.textContent).toContain("Create your first virtual library")
    expect(view.container.textContent).toContain(m.add_library())
  })

  it("links every degraded exception to the place that can resolve it", async () => {
    const degradedServer = { ...server, health: "degraded" } as ServerView
    const unusableLibrary = { ...library, name: "Offline films", sources: [] } as VirtualLibraryView
    const failure = {
      serverId: server.id,
      code: "DeliveryFailed",
      failedAtMs: 1,
      attemptCount: 2,
      nextAttemptAtMs: null,
      uncertainSinceMs: null
    } as OutboxFailureView
    const view = await renderOverview(overviewClient({
      servers: [degradedServer],
      libraries: [unusableLibrary],
      system: { ...system, upstreamHealthy: 0, upstreamDegraded: 1, outboxFailed: 1 },
      failures: [failure]
    }))

    expect(view.container.textContent).toContain("Home")
    expect(view.container.textContent).toContain("Offline films")
    expect(view.container.textContent).toContain("State synchronization needs attention")
    expect(view.container.textContent).toContain(m.servers())
    expect(view.container.textContent).toContain(m.libraries())
    expect(view.container.textContent).toContain(m.system())
  })

  it("renders one compact healthy state without metric cards", async () => {
    const view = await renderOverview(overviewClient({
      servers: [server], libraries: [library], system, failures: []
    }))

    expect(view.container.textContent).toContain("Everything is ready")
    expect(view.container.querySelector('[data-slot="card"]')).toBeNull()
    expect(view.container.textContent).toContain(m.servers())
    expect(view.container.textContent).toContain(m.libraries())
  })
})

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

  it("names each server edit action", () => {
    const archive = { ...server, id: "server-2", name: "Archive" }
    const markup = renderToStaticMarkup(
      <ServerList state="success" servers={[server, archive]} onRetry={vi.fn()} onCreate={vi.fn()} />
    )
    expect(markup).toContain(m.server_edit_action({ name: "Home" }))
    expect(markup).toContain(m.server_edit_action({ name: "Archive" }))
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

describe("library create prerequisites", () => {
  const renderPage = async (
    queryClient: QueryClient,
    props: Partial<React.ComponentProps<typeof LibrariesPage>> = {}
  ) => render(
    <QueryClientProvider client={queryClient}>
      <LibrariesPage
        creating
        onAddServer={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  )

  const queryClientWithLibraries = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    queryClient.setQueryData(queryKeys.libraries, [])
    return queryClient
  }

  it("shows server loading without silently rendering an empty form", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
    await renderPage(queryClientWithLibraries())

    expect(document.body.querySelector('[data-slot="skeleton"]')?.getAttribute("aria-label"))
      .toBe(m.servers_loading())
    expect(document.body.querySelector("form")).toBeNull()
  })

  it("shows a server error with retry without rendering the form", async () => {
    const fetch = vi.fn(async () => json({ _tag: "Internal", requestId: "request-1" }, 500))
    vi.stubGlobal("fetch", fetch)
    await renderPage(queryClientWithLibraries())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain(m.servers_load_failed())
    expect(document.body.querySelector("form")).toBeNull()

    await act(async () => {
      buttonByName(document.body, m.retry()).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("shows an actionable zero-server state without rendering the form", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])))
    const onAddServer = vi.fn()
    await renderPage(queryClientWithLibraries(), { onAddServer })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain(m.servers_empty())
    expect(document.body.querySelector("form")).toBeNull()
    await act(async () => buttonByName(document.body, m.add_server()).click())
    expect(onAddServer).toHaveBeenCalledOnce()
  })

  it("does not discover source libraries while the create form is closed", async () => {
    const fetch = vi.fn(async () => json([]))
    vi.stubGlobal("fetch", fetch)
    const queryClient = queryClientWithLibraries()
    queryClient.setQueryData(queryKeys.servers, [server])

    await renderPage(queryClient, { creating: false })
    await act(async () => { await Promise.resolve() })

    expect(fetch).not.toHaveBeenCalled()
  })

  it("discovers libraries for a healthy enabled server without a stable catalog id", async () => {
    const fetch = vi.fn(async () => json([source]))
    vi.stubGlobal("fetch", fetch)
    const queryClient = queryClientWithLibraries()
    queryClient.setQueryData(queryKeys.servers, [{ ...server, verifiedCatalogId: null }])

    await renderPage(queryClient)
    await act(async () => {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(document.body.querySelector("#source-server-1-source-1"))
        .toBeInstanceOf(HTMLInputElement))
    })
  })
})

it("shows libraries in server detail for a healthy enabled server without a stable catalog id", async () => {
  const fetch = vi.fn(async () => json([source]))
  vi.stubGlobal("fetch", fetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.server(server.id), { ...server, verifiedCatalogId: null })
  queryClient.setQueryData(queryKeys.serverHealth(server.id), {
    serverId: server.id,
    health: "healthy",
    lastSuccessAtMs: Date.now()
  })

  const view = await render(
    <QueryClientProvider client={queryClient}>
      <ServerDetailPage id={server.id} />
    </QueryClientProvider>
  )
  await act(async () => {
    await vi.waitFor(() => expect(view.container.textContent).toContain("Movies"))
  })

  expect(fetch).toHaveBeenCalledOnce()
  expect(view.container.textContent).not.toContain(m.source_libraries_unavailable())
})

it("keeps configured bindings visible and disable-able during discovery errors", async () => {
  const retry = vi.fn()
  const view = await render(
    <LibraryForm
      library={library}
      groups={[{ server, state: "error", sources: [], retry }]}
      onSave={vi.fn()}
    />
  )

  expect(view.container.textContent).toContain(m.source_libraries_failed())
  expect(view.container.textContent).toContain("Movies")
  const checkbox = view.container.querySelector('input[type="checkbox"]')
  expect(checkbox).toBeInstanceOf(HTMLInputElement)
  expect((checkbox as HTMLInputElement).checked).toBe(true)

  await act(async () => (checkbox as HTMLInputElement).click())
  expect((checkbox as HTMLInputElement).checked).toBe(false)
  expect(view.container.textContent).toContain(m.source_binding_disabled())
})

it("marks bindings from missing servers unavailable", async () => {
  const view = await render(<LibraryForm library={library} groups={[]} onSave={vi.fn()} />)

  expect(view.container.textContent).toContain("Movies")
  expect(view.container.textContent).toContain(m.source_libraries_unavailable())
})

it("associates the required-source error with its fieldset", async () => {
  const view = await render(
    <LibraryForm
      groups={[{ server, state: "success", sources: [source] }]}
      onSave={vi.fn()}
    />
  )
  const name = view.container.querySelector('input[name="name"]')
  if (!(name instanceof HTMLInputElement)) throw new Error("Library name input not found")
  await change(name, "Films")
  await act(async () => buttonByName(view.container, m.save()).click())

  const fieldset = view.container.querySelector("fieldset")
  await vi.waitFor(() => expect(fieldset?.getAttribute("aria-invalid")).toBe("true"))
  const descriptionId = fieldset?.getAttribute("aria-describedby")
  expect(descriptionId).toBe("sources-error")
  expect(view.container.querySelector(`#${descriptionId}`)?.textContent).toBe(m.library_sources_required())
})

it("ages current health into stale without a replacement payload and cleans up its timer", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const clearTimeout = vi.spyOn(window, "clearTimeout")
  const view = await render(
    <ServerHealthStatus
      health={{ serverId: server.id, health: "healthy", lastSuccessAtMs: 50_000 }}
    />
  )

  expect(view.container.textContent).toContain(m.health_current())
  expect(vi.getTimerCount()).toBe(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001) })
  expect(view.container.textContent).toContain(m.health_stale())

  await unmount(view)
  expect(clearTimeout).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
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
