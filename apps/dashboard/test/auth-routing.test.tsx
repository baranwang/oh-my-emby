import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient } from "@tanstack/react-query"
import { createMemoryHistory } from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { sectionFromPathname } from "../src/components/app-shell/app-shell.js"
import {
  SidebarInset,
  SidebarMenuButton,
  SidebarProvider,
  useSidebar
} from "../src/components/ui/sidebar.js"
import {
  handleUnauthorized,
  logout,
  sessionQueryOptions
} from "../src/modules/auth/services/auth-service.js"
import { queryKeys } from "../src/lib/query-keys.js"
import { createDashboardRouter } from "../src/router.js"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  status
})

const makeFetch = (responses: Record<string, Response | Error>) => vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const response = responses[url.pathname]
  if (response instanceof Error) throw response
  if (!response) return json({ _tag: "NotFound" }, 404)
  return response.clone()
})

const makeTestRouter = (path: string, fetch: typeof globalThis.fetch) => {
  vi.stubGlobal("fetch", fetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createDashboardRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient
  })
  return { queryClient, router }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each(["/dashboard/servers", "/servers"])(
  "derives the active shell section from %s",
  (pathname) => {
    expect(sectionFromPathname(pathname)).toBe("servers")
  }
)

it("renders shell content with exactly one main landmark", () => {
  const markup = renderToStaticMarkup(
    <SidebarInset><main id="main-content">Dashboard</main></SidebarInset>
  )

  expect(markup.match(/<main\b/g)).toHaveLength(1)
})

it("closes the mobile drawer after selecting navigation", async () => {
  vi.stubGlobal("innerWidth", 500)
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })))
  const Probe = () => {
    const sidebar = useSidebar()
    return (
      <>
        <button onClick={() => sidebar.setOpenMobile(true)}>Open</button>
        <output>{String(sidebar.openMobile)}</output>
        <SidebarMenuButton>Navigate</SidebarMenuButton>
      </>
    )
  }
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  await act(async () => root.render(
    <SidebarProvider labels={{ toggle: "Toggle", title: "Navigation", description: "Menu", close: "Close" }}>
      <Probe />
    </SidebarProvider>
  ))

  const buttons = [...container.querySelectorAll("button")]
  await act(async () => buttons.find((button) => button.textContent === "Open")?.click())
  expect(container.querySelector("output")?.textContent).toBe("true")
  await act(async () => buttons.find((button) => button.textContent === "Navigate")?.click())
  expect(container.querySelector("output")?.textContent).toBe("false")

  await act(async () => root.unmount())
  container.remove()
})

describe("Dashboard authentication routing", () => {
  it("redirects an uninitialized instance to setup", async () => {
    const { router } = makeTestRouter("/dashboard/servers", makeFetch({
      "/api/dashboard/bootstrap": json({ initialized: false })
    }))

    await router.load()

    expect(router.state.location.publicHref).toBe("/dashboard/setup")
  })

  it("redirects an initialized instance without a session to login", async () => {
    const { router } = makeTestRouter("/dashboard/", makeFetch({
      "/api/dashboard/bootstrap": json({ initialized: true }),
      "/api/dashboard/session": json({ authenticated: false, username: null })
    }))

    await router.load()

    expect(router.state.location.publicHref).toBe("/dashboard/login")
  })

  it("enters the authenticated shell with a valid session", async () => {
    const { router } = makeTestRouter("/dashboard/", makeFetch({
      "/api/dashboard/bootstrap": json({ initialized: true }),
      "/api/dashboard/session": json({ authenticated: true, username: "owner" })
    }))

    await router.load()

    expect(router.state.location.publicHref).toBe("/dashboard/")
    expect(router.state.matches.some((match) => match.routeId === "/_authenticated/"))
      .toBe(true)
  })

  it("keeps Dashboard API unavailability distinct from login failure", async () => {
    const { router } = makeTestRouter("/dashboard/", makeFetch({
      "/api/dashboard/bootstrap": new TypeError("network unavailable")
    }))

    await router.load()

    expect(router.state.location.publicHref).toBe("/dashboard/")
    expect(router.state.matches.some((match) => match.status === "error")).toBe(true)
  })

  it("resolves a direct authenticated link beneath the Dashboard base path", async () => {
    const { router } = makeTestRouter("/dashboard/servers", makeFetch({
      "/api/dashboard/bootstrap": json({ initialized: true }),
      "/api/dashboard/session": json({ authenticated: true, username: "owner" })
    }))

    await router.load()

    expect(router.state.location.publicHref).toBe("/dashboard/servers")
    expect(router.state.matches.some((match) => match.routeId === "/_authenticated/servers/"))
      .toBe(true)
  })
})

describe("protected Query cache", () => {
  it("clears every protected family and refreshes session after a 401", async () => {
    const fetch = makeFetch({
      "/api/dashboard/session": json({ authenticated: false, username: null })
    })
    vi.stubGlobal("fetch", fetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.fetchQuery(sessionQueryOptions)
    queryClient.setQueryData(queryKeys.servers, [{ id: "server-1" }])
    queryClient.setQueryData(queryKeys.server("server-1"), { id: "server-1" })
    queryClient.setQueryData(queryKeys.libraries, [{ id: "library-1" }])
    queryClient.setQueryData(queryKeys.system, { database: "healthy" })
    queryClient.setQueryData(queryKeys.session, { authenticated: true, username: "owner" })

    await handleUnauthorized(queryClient)

    expect(queryClient.getQueriesData({ queryKey: queryKeys.servers })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.libraries })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.system })).toEqual([])
    expect(queryClient.getQueryData(queryKeys.session)).toEqual({
      authenticated: false,
      username: null
    })
  })

  it("clears protected data and refreshes session after logout", async () => {
    const fetch = makeFetch({
      "/api/dashboard/logout": new Response(null, { status: 204 }),
      "/api/dashboard/session": json({ authenticated: false, username: null })
    })
    vi.stubGlobal("fetch", fetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.fetchQuery(sessionQueryOptions)
    queryClient.setQueryData(queryKeys.bootstrap, { initialized: true })
    queryClient.setQueryData(queryKeys.servers, [{ id: "server-1" }])
    queryClient.setQueryData(queryKeys.libraries, [{ id: "library-1" }])
    queryClient.setQueryData(queryKeys.system, { database: "healthy" })

    await logout(queryClient)

    expect(queryClient.getQueryData(queryKeys.bootstrap)).toEqual({ initialized: true })
    expect(queryClient.getQueriesData({ queryKey: queryKeys.servers })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.libraries })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.system })).toEqual([])
    expect(queryClient.getQueryData(queryKeys.session)).toEqual({
      authenticated: false,
      username: null
    })
  })

  it("clears protected data and refreshes session when logout is unauthorized", async () => {
    const fetch = makeFetch({
      "/api/dashboard/logout": json({ _tag: "Unauthorized" }, 401),
      "/api/dashboard/session": json({ authenticated: false, username: null })
    })
    vi.stubGlobal("fetch", fetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.fetchQuery(sessionQueryOptions)
    queryClient.setQueryData(queryKeys.servers, [{ id: "server-1" }])
    queryClient.setQueryData(queryKeys.libraries, [{ id: "library-1" }])
    queryClient.setQueryData(queryKeys.system, { database: "healthy" })
    queryClient.setQueryData(queryKeys.session, { authenticated: true, username: "owner" })

    await expect(logout(queryClient)).rejects.toMatchObject({ _tag: "Unauthorized" })

    expect(queryClient.getQueriesData({ queryKey: queryKeys.servers })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.libraries })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.system })).toEqual([])
    expect(queryClient.getQueryData(queryKeys.session)).toEqual({
      authenticated: false,
      username: null
    })
  })
})
