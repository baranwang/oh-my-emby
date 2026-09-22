import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { ServerView, VirtualLibraryView } from "@oh-my-emby/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDashboardRouter } from "../src/router.js"
import { m } from "../src/paraglide/messages.js"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
} as ServerView

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  status
})

const fetchFor = (options?: { readonly missing?: boolean; readonly saveFails?: boolean }) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/dashboard/bootstrap") return json({ initialized: true })
    if (pathname === "/api/dashboard/session") return json({ authenticated: true, username: "owner" })
    if (pathname === "/api/dashboard/libraries" && request.method === "GET") return json([library])
    if (pathname === "/api/dashboard/libraries" && request.method === "POST") {
      return options?.saveFails
        ? json({ _tag: "Internal", requestId: "request-1" }, 500)
        : json(library)
    }
    if (pathname === "/api/dashboard/libraries/library-1") {
      return options?.missing ? json({ _tag: "NotFound" }, 404) : json(library)
    }
    if (pathname === "/api/dashboard/servers") return json([server])
    if (pathname === "/api/dashboard/servers/server-1/libraries") {
      return json([{ id: "source-1", serverId: "server-1", name: "Movies", mediaType: "movies" }])
    }
    return json({ _tag: "NotFound" }, 404)
  })

const mounted: Array<{ container: HTMLDivElement; root: Root }> = []

const renderRoute = async (path: string, fetch: typeof globalThis.fetch) => {
  vi.stubGlobal("fetch", fetch)
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })))
  vi.stubGlobal("scrollTo", vi.fn())
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createDashboardRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient
  })
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  mounted.push({ container, root })
  await router.load()
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>
  ))
  await vi.waitFor(() => expect(document.body.querySelector('[data-slot="drawer-popup"]')).not.toBeNull())
  return { container, router }
}

const button = (name: string) => {
  const found = [...document.body.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(name) || candidate.getAttribute("aria-label") === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`)
  return found
}

const change = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

afterEach(async () => {
  while (mounted.length) {
    const item = mounted.pop()
    if (!item) continue
    await act(async () => item.root.unmount())
    item.container.remove()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("route-controlled virtual-library Drawer", () => {
  it("opens create from ?new=true and close returns to the collection route", async () => {
    const { router } = await renderRoute("/dashboard/libraries?new=true", fetchFor())

    expect(document.body.textContent).toContain(m.library_create_title())
    expect(router.state.location.publicHref).toBe("/dashboard/libraries?new=true")
    await act(async () => button(m.cancel()).click())
    await act(async () => { await vi.waitFor(() => expect(router.state.location.publicHref).toBe("/dashboard/libraries")) })
  })

  it("opens edit over the same list from a refreshable $id deep link", async () => {
    const { container, router } = await renderRoute("/dashboard/libraries/library-1", fetchFor())

    expect(container.textContent).toContain(m.libraries())
    expect(container.textContent).toContain("Films")
    expect(document.body.textContent).toContain(m.library_edit_title())
    expect(router.state.location.publicHref).toBe("/dashboard/libraries/library-1")
  })

  it("renders a typed missing-ID failure with a collection return action", async () => {
    const { router } = await renderRoute("/dashboard/libraries/library-1", fetchFor({ missing: true }))

    await vi.waitFor(() => expect(document.body.textContent).toContain("Library not found"))
    await act(async () => button("Back to libraries").click())
    await act(async () => { await vi.waitFor(() => expect(router.state.location.publicHref).toBe("/dashboard/libraries")) })
  })

  it("closes after save and keeps the create Drawer plus values after failure", async () => {
    const success = await renderRoute("/dashboard/libraries?new=true", fetchFor())
    await vi.waitFor(() => expect(document.body.querySelector('input[type="checkbox"][id^="source-"]'))
      .toBeInstanceOf(HTMLInputElement))
    const name = document.body.querySelector('input[name="name"]') as HTMLInputElement
    const source = document.body.querySelector('input[type="checkbox"][id^="source-"]') as HTMLInputElement
    await act(async () => {
      change(name, "New films")
      source.click()
      button(m.save()).click()
    })
    await act(async () => { await vi.waitFor(() => expect(success.router.state.location.publicHref).toBe("/dashboard/libraries")) })

    while (mounted.length) {
      const item = mounted.pop()
      if (!item) continue
      await act(async () => item.root.unmount())
      item.container.remove()
    }

    const failed = await renderRoute("/dashboard/libraries?new=true", fetchFor({ saveFails: true }))
    await vi.waitFor(() => expect(document.body.querySelector('input[type="checkbox"][id^="source-"]'))
      .toBeInstanceOf(HTMLInputElement))
    const failedName = document.body.querySelector('input[name="name"]') as HTMLInputElement
    const failedSource = document.body.querySelector('input[type="checkbox"][id^="source-"]') as HTMLInputElement
    await act(async () => {
      change(failedName, "Keep me")
      failedSource.click()
      button(m.save()).click()
    })
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain(m.library_save_failed())) })
    expect(failed.router.state.location.publicHref).toBe("/dashboard/libraries?new=true")
    expect(failedName.value).toBe("Keep me")
  })
})
