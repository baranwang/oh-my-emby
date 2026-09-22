import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ThemeProvider } from "../src/components/theme-provider.js"
import { createDashboardRouter } from "../src/router.js"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const system = {
  database: "healthy",
  cacheEntries: 3,
  maintenanceLastRunAtMs: null,
  outboxPending: 0,
  outboxFailed: 0,
  outboxUncertain: 0,
  upstreamHealthy: 1,
  upstreamDegraded: 0,
  upstreamUnknown: 0
} as const

const metadata = {
  providers: [
    { id: "tmdb", enabled: true, order: 0, language: "en-US", hasCredential: true, status: "ready" },
    { id: "trakt", enabled: false, order: 1, language: null, hasCredential: false, status: "unconfigured" }
  ]
} as const

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  status
})

const fetchFor = (status = system) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init)
  const pathname = new URL(request.url).pathname
  if (pathname === "/api/dashboard/bootstrap") return json({ initialized: true })
  if (pathname === "/api/dashboard/session") return json({ authenticated: true, username: "owner" })
  if (pathname === "/api/dashboard/system") return json(status)
  if (pathname === "/api/dashboard/system/outbox-failures") return json([])
  if (pathname === "/api/dashboard/metadata-settings" && request.method === "GET") return json(metadata)
  if (pathname === "/api/dashboard/metadata-settings" && request.method === "PUT") return json(metadata)
  return json({ _tag: "NotFound" }, 404)
})

const mounted: Array<{ container: HTMLDivElement; root: Root }> = []

const renderSystem = async (status = system) => {
  const fetch = fetchFor(status)
  vi.stubGlobal("fetch", fetch)
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })))
  vi.stubGlobal("scrollTo", vi.fn())
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createDashboardRouter({
    history: createMemoryHistory({ initialEntries: ["/dashboard/system"] }),
    queryClient
  })
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  mounted.push({ container, root })
  await router.load()
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider storageKey="test-theme">
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  ))
  return { container, fetch }
}

const buttonIn = (container: ParentNode, name: string) => {
  const found = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(name) || candidate.getAttribute("aria-label") === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`)
  return found
}

const unmountAll = async () => {
  while (mounted.length) {
    const item = mounted.pop()
    if (!item) continue
    await act(async () => item.root.unmount())
    item.container.remove()
  }
}

const change = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

const savedCredential = async (fetch: ReturnType<typeof fetchFor>) => {
  await vi.waitFor(() => expect(fetch.mock.calls.some(([input, init]) =>
    (input instanceof Request ? input : new Request(input, init)).method === "PUT"
  )).toBe(true))
  const [input, init] = fetch.mock.calls.find(([candidate, candidateInit]) =>
    (candidate instanceof Request ? candidate : new Request(candidate, candidateInit)).method === "PUT"
  )!
  const request = input instanceof Request ? input : new Request(input, init)
  const payload = await request.clone().json() as {
    readonly providers: ReadonlyArray<{ readonly id: string; readonly credential: { readonly _tag: string; readonly value?: string } }>
  }
  return payload.providers.find((provider) => provider.id === "tmdb")!.credential
}

afterEach(async () => {
  await unmountAll()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("System settings", () => {
  it("orders lightweight sections and keeps diagnostics last", async () => {
    const { container } = await renderSystem()
    await vi.waitFor(() => expect(container.textContent).toContain("Metadata providers"))

    const headings = [...container.querySelectorAll("main section > h2")].map((heading) => heading.textContent)
    expect(headings).toEqual([
      "Metadata providers",
      "Client endpoint",
      "Runtime and database",
      "Preferences",
      "Advanced diagnostics"
    ])
    expect(container.querySelectorAll('[data-slot="separator"]')).toHaveLength(4)
    expect((container.querySelector('[aria-label="Client endpoint"]') as HTMLInputElement).value)
      .toBe(globalThis.location.origin)
    const preferences = container.querySelector("#preferences-title")?.parentElement
    expect(preferences?.textContent).toContain("Language")
    expect(preferences?.textContent).toContain("Theme")
  })

  it("shows provider state, editable external providers, and the immutable fallback last", async () => {
    const { container } = await renderSystem()
    await vi.waitFor(() => expect(container.textContent).toContain("TMDB"))

    const rows = [...container.querySelectorAll("[data-provider-row]")]
    expect(rows.map((row) => row.querySelector("h3")?.textContent)).toEqual(["TMDB", "Trakt", "Upstream server"])
    expect(rows[0]?.textContent).toContain("Configured")
    expect(rows[0]?.textContent).toContain("Enabled")
    expect(rows[1]?.textContent).toContain("Not configured")
    expect(rows[1]?.textContent).toContain("Disabled")
    expect(rows[0]?.textContent).not.toContain("Images")
    expect(rows[0]?.textContent).not.toContain("Metadata")
    expect(buttonIn(rows[0]!, "Settings")).toBeInstanceOf(HTMLButtonElement)
    expect(rows[0]?.lastElementChild?.querySelector('button[aria-label*="Move"]')).not.toBeNull()
    expect(rows[2]?.querySelector("button")).toBeNull()
  })

  it("opens provider-specific generated Drawers without reading credentials back", async () => {
    const { container } = await renderSystem()
    await vi.waitFor(() => expect(container.textContent).toContain("TMDB"))
    const rows = [...container.querySelectorAll("[data-provider-row]")]

    await act(async () => buttonIn(rows[0]!, "Settings").click())
    await vi.waitFor(() => expect(document.body.textContent).toContain("TMDB settings"))
    const token = document.body.querySelector('input[name="credential"]') as HTMLInputElement
    expect(token).toBeInstanceOf(HTMLInputElement)
    expect(token.value).toBe("")
    expect(document.body.textContent).toContain("API Read Access Token")
    expect(document.body.textContent).toContain("Language")
    expect(document.body.textContent).not.toContain("Client ID")

    await act(async () => buttonIn(document.body, "Cancel").click())
    await act(async () => buttonIn(rows[1]!, "Settings").click())
    await vi.waitFor(() => expect(document.body.textContent).toContain("Trakt settings"))
    expect(document.body.textContent).toContain("Client ID")
    expect(document.body.textContent).not.toContain("API Read Access Token")
  })

  it("requires explicit confirmation before clearing a write-only credential", async () => {
    const canceled = await renderSystem()
    await vi.waitFor(() => expect(canceled.container.textContent).toContain("TMDB"))
    await act(async () => buttonIn(canceled.container.querySelectorAll("[data-provider-row]")[0]!, "Settings").click())
    await act(async () => buttonIn(document.body, "Clear saved credential").click())
    expect(document.body.textContent).toContain("Confirm credential removal")
    expect(canceled.fetch.mock.calls.some(([input, init]) =>
      (input instanceof Request ? input : new Request(input, init)).method === "PUT"
    )).toBe(false)
    await act(async () => buttonIn(document.body, "Cancel").click())
    await act(async () => buttonIn(document.body, "Save").click())
    expect(await savedCredential(canceled.fetch)).toEqual({ _tag: "Preserve" })

    await unmountAll()
    const confirmed = await renderSystem()
    await vi.waitFor(() => expect(confirmed.container.textContent).toContain("TMDB"))
    await act(async () => buttonIn(confirmed.container.querySelectorAll("[data-provider-row]")[0]!, "Settings").click())
    await act(async () => buttonIn(document.body, "Clear saved credential").click())
    await act(async () => buttonIn(document.body, "Confirm credential removal").click())
    expect(document.body.textContent).toContain("Saved credential will be cleared when you save")
    await act(async () => buttonIn(document.body, "Save").click())
    expect(await savedCredential(confirmed.fetch)).toEqual({ _tag: "Clear" })

    await unmountAll()
    const edited = await renderSystem()
    await vi.waitFor(() => expect(edited.container.textContent).toContain("TMDB"))
    await act(async () => buttonIn(edited.container.querySelectorAll("[data-provider-row]")[0]!, "Settings").click())
    await act(async () => buttonIn(document.body, "Clear saved credential").click())
    await act(async () => change(document.body.querySelector('input[name="credential"]')!, "replacement"))
    expect(document.body.textContent).not.toContain("Confirm credential removal")
    await act(async () => buttonIn(document.body, "Save").click())
    expect(await savedCredential(edited.fetch)).toEqual({ _tag: "Set", value: "replacement" })
  })

  it("keeps outbox detail collapsed until failed or uncertain work exists", async () => {
    const healthy = await renderSystem()
    await vi.waitFor(() => expect(healthy.container.textContent).toContain("Advanced diagnostics"))
    expect(healthy.container.querySelector("details")?.open).toBe(false)

    const item = mounted.pop()!
    await act(async () => item.root.unmount())
    item.container.remove()

    const unhealthy = await renderSystem({ ...system, outboxFailed: 1 })
    await vi.waitFor(() => expect(unhealthy.container.textContent).toContain("Advanced diagnostics"))
    expect(unhealthy.container.querySelector("details")?.open).toBe(true)
  })
})
