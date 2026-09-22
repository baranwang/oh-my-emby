import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { ServerView } from "@oh-my-emby/contracts"
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
    if (pathname === "/api/dashboard/servers" && request.method === "GET") return json([server])
    if (pathname === "/api/dashboard/servers" && request.method === "POST") {
      return options?.saveFails
        ? json({ _tag: "Internal", requestId: "request-1" }, 500)
        : json(server)
    }
    if (pathname === "/api/dashboard/servers/server-1") {
      return options?.missing ? json({ _tag: "NotFound" }, 404) : json(server)
    }
    if (pathname === "/api/dashboard/servers/server-1/health") {
      return json({ serverId: "server-1", health: "healthy", lastSuccessAtMs: 1 })
    }
    if (pathname === "/api/dashboard/servers/server-1/libraries") return json([])
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

describe("route-controlled server Drawer", () => {
  it("opens create from ?new=true and close returns to the collection route", async () => {
    const { router } = await renderRoute("/dashboard/servers?new=true", fetchFor())

    expect(document.body.textContent).toContain(m.server_create_title())
    expect(router.state.location.publicHref).toBe("/dashboard/servers?new=true")
    await act(async () => button(m.cancel()).click())
    await act(async () => { await vi.waitFor(() => expect(router.state.location.publicHref).toBe("/dashboard/servers")) })
  })

  it("opens edit over the same server list from a refreshable $id deep link", async () => {
    const { container, router } = await renderRoute("/dashboard/servers/server-1", fetchFor())

    expect(container.textContent).toContain(m.servers())
    expect(container.textContent).toContain("Home")
    expect(document.body.textContent).toContain(m.server_edit_title())
    expect(router.state.location.publicHref).toBe("/dashboard/servers/server-1")
  })

  it("renders a typed missing-ID failure with a collection return action", async () => {
    const { router } = await renderRoute("/dashboard/servers/server-1", fetchFor({ missing: true }))

    await vi.waitFor(() => expect(document.body.textContent).toContain("Server not found"))
    await act(async () => button("Back to servers").click())
    await act(async () => { await vi.waitFor(() => expect(router.state.location.publicHref).toBe("/dashboard/servers")) })
  })

  it("closes after a successful save and retains the Drawer plus values after failure", async () => {
    const success = await renderRoute("/dashboard/servers?new=true", fetchFor())
    const name = document.body.querySelector('input[name="name"]') as HTMLInputElement
    const host = document.body.querySelector('input[name="endpoints[0].host"]') as HTMLInputElement
    const username = document.body.querySelector('input[name="username"]') as HTMLInputElement
    const password = document.body.querySelector('input[name="password"]') as HTMLInputElement
    await act(async () => {
      for (const [input, value] of [[name, "New server"], [host, "new.example.com"], [username, "alice"], [password, "secret"]] as const) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
      }
      button(m.save()).click()
    })
    await act(async () => { await vi.waitFor(() => expect(success.router.state.location.publicHref).toBe("/dashboard/servers")) })

    while (mounted.length) {
      const item = mounted.pop()
      if (!item) continue
      await act(async () => item.root.unmount())
      item.container.remove()
    }

    const failed = await renderRoute("/dashboard/servers?new=true", fetchFor({ saveFails: true }))
    const failedName = document.body.querySelector('input[name="name"]') as HTMLInputElement
    const failedHost = document.body.querySelector('input[name="endpoints[0].host"]') as HTMLInputElement
    const failedUsername = document.body.querySelector('input[name="username"]') as HTMLInputElement
    const failedPassword = document.body.querySelector('input[name="password"]') as HTMLInputElement
    await act(async () => {
      for (const [input, value] of [
        [failedName, "Keep me"],
        [failedHost, "failed.example.com"],
        [failedUsername, "alice"],
        [failedPassword, "secret"]
      ] as const) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
      }
      button(m.save()).click()
    })
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain(m.server_save_failed())) })
    expect(failed.router.state.location.publicHref).toBe("/dashboard/servers?new=true")
    expect(failedName.value).toBe("Keep me")
  })
})
