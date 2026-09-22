import { act } from "react"
import { createRoot } from "react-dom/client"
import type { MetadataProviderSettingsInput, ServerInput, ServerView } from "@oh-my-emby/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import { queryKeys } from "../src/lib/query-keys.js"
import { changePassword, sessionQueryOptions } from "../src/modules/auth/services/auth-service.js"
import { createLibrary, updateLibrary } from "../src/modules/libraries/services/library-service.js"
import {
  createServer,
  serverHealthRefetchInterval,
  serverLibrariesQueryOptions,
  testServerConnection,
  updateServer
} from "../src/modules/servers/services/server-service.js"
import { useServerHealth } from "../src/modules/servers/hooks/use-servers.js"
import { updateMetadataSettings } from "../src/modules/system/services/system-service.js"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const input = {
  name: "Home",
  endpoints: [{ protocol: "https", host: "emby.example.com", port: null, path: "" }],
  username: "alice",
  password: { _tag: "Preserve" },
  userAgentPolicy: "fixed",
  userAgent: "SenPlayer/1",
  enabled: true
} as ServerInput

const server = {
  id: "server-1",
  name: input.name,
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
  username: input.username,
  hasPassword: true,
  userAgentPolicy: input.userAgentPolicy,
  userAgent: input.userAgent,
  enabled: input.enabled,
  verifiedCatalogId: "catalog-1",
  generation: 2,
  health: "healthy"
} as unknown as ServerView

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  status
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("server query behavior", () => {
  it("centralizes the approved query keys", () => {
    expect(queryKeys.outboxFailures).toEqual(["system", "outbox-failures"])
    expect(queryKeys.serverHealth("server-1")).toEqual(["servers", "server-1", "health"])
    expect(queryKeys.serverLibraries("server-1")).toEqual(["servers", "server-1", "libraries"])
  })

  it("invalidates the saved server and every existing Overview constituent without optimistic writes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(server)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const write = vi.spyOn(queryClient, "setQueryData")

    await updateServer("server-1", input, queryClient)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.server("server-1"), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.servers, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.serverHealth("server-1"), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.serverLibraries("server-1"), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.libraries, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.system, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.outboxFailures, exact: true })
    expect(write).not.toHaveBeenCalled()
  })

  it("polls health every 30 seconds only while the page is visible", () => {
    expect(serverHealthRefetchInterval("visible")).toBe(30_000)
    expect(serverHealthRefetchInterval("hidden")).toBe(false)
  })

  it("re-evaluates health polling when page visibility changes", async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = "visible"
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
    const fetch = vi.fn(async () => json({ serverId: "server-1", health: "healthy", lastSuccessAtMs: 1 }))
    vi.stubGlobal("fetch", fetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    const Probe = () => {
      useServerHealth("server-1" as ServerView["id"])
      return null
    }

    await act(async () => root.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>))
    await act(async () => { await Promise.resolve() })
    const initialCalls = fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(fetch.mock.calls.length).toBeGreaterThan(initialCalls)

    visibility = "hidden"
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    const hiddenCalls = fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetch).toHaveBeenCalledTimes(hiddenCalls)

    visibility = "visible"
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(fetch.mock.calls.length).toBeGreaterThan(hiddenCalls)

    await act(async () => root.unmount())
    container.remove()
  })

  it("discovers source libraries through the dedicated server query", async () => {
    const fetch = vi.fn(async () => json([{
      id: "source-1",
      serverId: "server-1",
      name: "Movies",
      mediaType: "movies"
    }]))
    vi.stubGlobal("fetch", fetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const sources = await queryClient.fetchQuery(serverLibrariesQueryOptions("server-1", queryClient))

    expect(sources).toEqual([expect.objectContaining({ id: "source-1", name: "Movies" })])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("refreshes the server family after a successful connection test", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      reachable: true,
      catalogId: "catalog-1",
      endpoints: [{
        endpointId: "endpoint-1",
        reachable: true,
        catalogId: "catalog-1",
        health: "healthy"
      }]
    })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()

    await testServerConnection("server-1", queryClient)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.server("server-1"), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.servers, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.serverHealth("server-1"), exact: true })
  })

  it("invalidates the list and Overview constituents after creating a server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(server)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const write = vi.spyOn(queryClient, "setQueryData")

    await createServer({ ...input, password: { _tag: "Set", value: "secret" } }, queryClient)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.servers, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.libraries, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.system, exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.outboxFailures, exact: true })
    expect(write).not.toHaveBeenCalled()
  })
})

describe("library and account mutation behavior", () => {
  const libraryInput = {
    name: "Films",
    mediaType: "movies",
    sources: [{ serverId: "server-1", sourceLibraryId: "source-1", enabled: true }],
    enabled: true
  } as const
  const library = {
    id: "library-1",
    name: "Films",
    mediaType: "movies",
    sources: [{ serverId: "server-1", sourceLibraryId: "source-1", sourceLibraryName: "Movies", enabled: true }],
    enabled: true
  }

  it("invalidates only the created library list without optimistic writes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(library)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const write = vi.spyOn(queryClient, "setQueryData")

    await createLibrary(libraryInput, queryClient)

    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.libraries })
    expect(write).not.toHaveBeenCalled()
  })

  it("invalidates only the updated library family without optimistic writes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(library)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const write = vi.spyOn(queryClient, "setQueryData")

    await updateLibrary("library-1" as never, libraryInput, queryClient)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.library("library-1") })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.libraries })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.servers })
    expect(write).not.toHaveBeenCalled()
  })

  it("clears protected data and refreshes session after password change", async () => {
    let sessionRequests = 0
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const pathname = new URL(request instanceof Request ? request.url : request.toString()).pathname
      return pathname === "/api/dashboard/password"
        ? new Response(null, { status: 204 })
        : json(sessionRequests++ === 0
          ? { authenticated: true, username: "owner" }
          : { authenticated: false, username: null })
    })
    vi.stubGlobal("fetch", fetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.fetchQuery(sessionQueryOptions)
    queryClient.setQueryData(queryKeys.servers, [server])
    queryClient.setQueryData(queryKeys.libraries, [library])
    queryClient.setQueryData(queryKeys.system, { database: "healthy" })

    await changePassword({ currentPassword: "current", newPassword: "new" }, queryClient)

    expect(queryClient.getQueriesData({ queryKey: queryKeys.servers })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.libraries })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: queryKeys.system })).toEqual([])
    expect(queryClient.getQueryData(queryKeys.session)).toEqual({ authenticated: false, username: null })
  })
})

it("invalidates only metadata settings after an atomic provider update", async () => {
  const metadataInput = {
    providers: [
      { id: "tmdb", enabled: true, order: 0, language: "en-US", credential: { _tag: "Set", value: "token" } },
      { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
    ]
  } as MetadataProviderSettingsInput
  vi.stubGlobal("fetch", vi.fn(async () => json({
    providers: [
      { id: "tmdb", enabled: true, order: 0, language: "en-US", hasCredential: true, status: "ready" },
      { id: "trakt", enabled: false, order: 1, language: null, hasCredential: false, status: "unconfigured" }
    ]
  })))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()

  await updateMetadataSettings(metadataInput, queryClient)

  expect(invalidate).toHaveBeenCalledOnce()
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.metadataSettings, exact: true })
})
