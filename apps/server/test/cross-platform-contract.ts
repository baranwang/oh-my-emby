import { Effect, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { UpstreamUnavailable } from "../src/core/errors.js"
import { Federation, makeFederationLayer } from "../src/core/federation.js"
import { makeIdentityLayer } from "../src/core/identity.js"
import { makeMetadataProvidersLayer, MetadataProviders } from "../src/core/metadata-providers.js"
import type { UpstreamServer } from "../src/core/model.js"
import { Repositories, type RepositoriesService } from "../src/core/repositories.js"
import { makeUpstreamClientLayer, UpstreamClient } from "../src/core/upstream-client.js"

export interface AcceptanceApp {
  readonly publicOrigin: string
  readonly repositories: Layer.Layer<Repositories>
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly inspectStorage: () => Promise<{
    readonly migrationNames: ReadonlyArray<string>
    readonly enabledEncoding: number
  }>
  readonly reopenRepositories: () => Layer.Layer<Repositories>
  readonly close: () => Promise<void>
}

export interface AcceptanceHarness {
  readonly startFresh: () => Promise<AcceptanceApp>
}

const ownerFixture = { username: "owner", password: "valid password" }
const serverFixture = (index: number): UpstreamServer => ({
  id: `server-${index}`,
  catalogNamespace: `catalog:${index}`,
  verifiedCatalogId: `catalog-id:${index}`,
  verifiedBaseUrl: `https://server-${index}.example.com`,
  generation: 1,
  name: `Server ${index}`,
  baseUrl: `https://server-${index}.example.com/` as any,
  endpoints: [{
    id: `server-${index}:endpoint`,
    protocol: "https",
    host: `server-${index}.example.com`,
    port: null,
    path: "",
    displayUrl: `https://server-${index}.example.com/` as any,
    verifiedCatalogId: `catalog-id:${index}`,
    health: "healthy",
    lastSuccessAtMs: 1_000,
    order: 0,
    createdAtMs: 1_000 + index,
    updatedAtMs: 2_000 + index
  }],
  username: "upstream-user",
  password: "upstream-password",
  accessToken: `token-${index}`,
  accessTokenExpiresAtMs: null,
  upstreamUserId: `upstream-user-${index}`,
  userAgentPolicy: "fixed",
  userAgent: "oh-my-emby-acceptance",
  enabled: true,
  health: "healthy",
  lastSuccessAtMs: 1_000,
  deletedAtMs: null,
  createdAtMs: 1_000 + index,
  updatedAtMs: 2_000 + index
})

const useRepositories = <A>(
  layer: Layer.Layer<Repositories>,
  use: (repositories: RepositoriesService) => Effect.Effect<A, unknown>
): Promise<A> => Effect.runPromise(Effect.gen(function*() {
  return yield* use(yield* Repositories)
}).pipe(Effect.provide(layer)))

const jsonHeaders = (origin: string) => ({
  "content-type": "application/json",
  origin
})

const cookieFrom = (response: Response): string => response.headers.get("set-cookie")!.split(";", 1)[0]!

const upstreamItem = (serverId: string) => ({
  Id: `${serverId}-movie`,
  Type: "Movie",
  Name: serverId === "server-0" ? "Zulu" : "Alpha",
  Overview: "Upstream overview",
  ProviderIds: { Imdb: "tt10", Tmdb: "10" },
  MediaSources: [{
    Id: `${serverId}-media`,
    Name: `${serverId} version`,
    Container: "mkv",
    MediaStreams: [
      { Index: 0, Type: "Video", Codec: "h264" },
      { Index: 2, Type: "Subtitle", Codec: "srt", IsExternal: true, IsTextSubtitleStream: true }
    ]
  }]
})

export const acceptanceUpstreamFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname === "api.themoviedb.org") {
    return new Response("Unavailable", { status: 503 })
  }
  if (url.hostname === "api.trakt.tv") {
    return Response.json({ title: "Trakt title", ids: { imdb: "tt10" } })
  }
  if (["setup.example.com", "primary.example.com", "secondary.example.com"].includes(url.hostname) &&
    url.pathname.endsWith("/Users/AuthenticateByName") && request.method === "POST") {
    return Response.json({
      AccessToken: "setup-access-token",
      ServerId: "setup-catalog-id",
      User: { Id: "setup-upstream-user" }
    })
  }
  const source = /^server-(\d+)\.example\.com$/.exec(url.hostname)?.[1]
  if (source !== undefined && url.pathname === "/Items") {
    const serverId = `server-${source}`
    return serverId === "server-2"
      ? new Response("Unavailable", { status: 503 })
      : Response.json({ Items: [upstreamItem(serverId)], TotalRecordCount: 1 })
  }
  return new Response("Not Found", { status: 404 })
}

const embyAuthorization =
  'MediaBrowser Client="SenPlayer", Device="Acceptance", DeviceId="acceptance-device", Version="1"'

const claimOwner = async (app: AcceptanceApp): Promise<string> => {
  const claim = await app.request("/api/dashboard/claim", {
    method: "POST",
    headers: jsonHeaders(app.publicOrigin),
    body: JSON.stringify(ownerFixture)
  })
  expect(claim.status).toBe(200)
  return cookieFrom(claim)
}

const loginEmby = async (app: AcceptanceApp): Promise<string> => {
  const login = await app.request("/Users/AuthenticateByName", {
    method: "POST",
    headers: { "content-type": "application/json", "x-emby-authorization": embyAuthorization },
    body: JSON.stringify({ Username: ownerFixture.username, Pw: ownerFixture.password })
  })
  expect(login.status).toBe(200)
  return String(((await login.json()) as { AccessToken?: string }).AccessToken)
}

const prepareFederation = async (app: AcceptanceApp) => {
  await useRepositories(app.repositories, (repositories) => Effect.gen(function*() {
    for (let index = 0; index < 3; index++) yield* repositories.saveServer(serverFixture(index))
    yield* repositories.saveVirtualLibrary({
      id: "library-1" as any,
      name: "Movies",
      mediaType: "movies",
      enabled: true,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      sources: Array.from({ length: 3 }, (_, index) => ({
        serverId: `server-${index}` as any,
        sourceLibraryId: `movies-${index}` as any,
        sourceLibraryName: `Movies ${index}`,
        mediaType: "movies" as const,
        sourceOrder: index,
        enabled: true
      }))
    }, Array.from({ length: 3 }, (_, index) => ({
      serverId: `server-${index}`,
      generation: 1
    })))
  }))

  let listCalls = 0
  const upstream = Layer.succeed(UpstreamClient, UpstreamClient.of({
    request: ({ serverId }) => {
      listCalls++
      return serverId === "server-2"
        ? Effect.fail(new UpstreamUnavailable({ serverId }))
        : Effect.succeed({ Items: [upstreamItem(serverId)], TotalRecordCount: 1 })
    },
    authenticate: () => Effect.die("unused"),
    getServerIdentity: () => Effect.die("unused"),
    listSourceLibraries: () => Effect.die("unused"),
    resolvePlayback: (version) => Effect.succeed({
      serverId: String((version.capabilities as Record<string, unknown>).serverId),
      generation: version.serverGeneration,
      url: String((version.capabilities as Record<string, unknown>).url)
    }),
    requestResource: () => Effect.die("unused")
  }))
  const identity = makeIdentityLayer.pipe(Layer.provide(app.repositories))
  const metadataProviders = Layer.succeed(MetadataProviders, MetadataProviders.of({
    refresh: (record) => Effect.succeed(record),
    overlayCached: (record) => Effect.succeed(record),
    resolveCachedImage: () => Effect.succeed(null)
  }))
  const dependencies = Layer.mergeAll(app.repositories, identity, upstream, metadataProviders)
  const federation = makeFederationLayer().pipe(Layer.provide(dependencies))
  const layer = Layer.mergeAll(dependencies, federation)
  const query = {
    userId: "owner",
    deviceId: "acceptance-device",
    virtualLibraryId: "library-1" as any,
    startIndex: 0,
    limit: 20,
    sort: [{ field: "Name" as const, direction: "Ascending" as const }],
    filters: [],
    itemTypes: []
  }
  const page = await Effect.runPromise(Effect.gen(function*() {
    return yield* (yield* Federation).list(query)
  }).pipe(Effect.provide(layer)))
  const detailed = await Effect.runPromise(Effect.gen(function*() {
    return yield* (yield* Federation).detail(page.items[0]!.id)
  }).pipe(Effect.provide(layer)))
  return {
    layer,
    page,
    detailed,
    query,
    listCalls: () => listCalls
  }
}

export const crossPlatformAcceptance = (
  name: "workers" | "docker",
  harness: AcceptanceHarness
) => describe(`${name} cross-platform acceptance`, () => {
  let app: AcceptanceApp

  beforeEach(async () => {
    app = await harness.startFresh()
  })

  afterEach(async () => {
    await app?.close()
  })

  it("supports claim, server setup, deep-link routing, and secret-safe status", async () => {
    const publicBodies: Array<string> = []
    const cookie = await claimOwner(app)

    const created = await app.request("/api/dashboard/servers", {
      method: "POST",
      headers: { ...jsonHeaders(app.publicOrigin), cookie },
      body: JSON.stringify({
        name: "Setup server",
        endpoints: [{ protocol: "https", host: "setup.example.com", port: null, path: "" }],
        username: "upstream-user",
        password: { _tag: "Set", value: "upstream-password" },
        userAgentPolicy: "fixed",
        userAgent: "oh-my-emby-acceptance",
        enabled: true
      })
    })
    publicBodies.push(await created.clone().text())
    expect(created.status).toBe(200)
    const createdServer = (await created.clone().json()) as { id: string }
    await expect(created.clone().json()).resolves.toMatchObject({
      id: createdServer.id,
      hasPassword: true,
      health: "unknown"
    })

    const verified = await app.request(`/api/dashboard/servers/${createdServer.id}/test`, {
      method: "POST",
      headers: { origin: app.publicOrigin, cookie }
    })
    publicBodies.push(await verified.clone().text())
    expect(verified.status).toBe(200)
    await expect(verified.clone().json()).resolves.toEqual({
      reachable: true,
      catalogId: "setup-catalog-id",
        endpoints: [
          {
            endpointId: expect.any(String),
            reachable: true,
            catalogId: "setup-catalog-id",
            health: "healthy"
          }
        ]
      })

    const servers = await app.request("/api/dashboard/servers", { headers: { cookie } })
    publicBodies.push(await servers.clone().text())
    expect(servers.status).toBe(200)
    await expect(servers.clone().json()).resolves.toEqual([
      expect.objectContaining({ id: createdServer.id, hasPassword: true, health: "healthy" })
    ])

    const deepLink = await app.request("/dashboard/servers", {
      headers: { accept: "text/html" }
    })
    publicBodies.push(await deepLink.clone().text())
    expect(deepLink.status).toBe(200)
    expect(publicBodies.join("\n")).not.toContain("upstream-password")
  })

  it("aligns ordered endpoints, User-Agent policy, and metadata fallback without exposing secrets", async () => {
    const cookie = await claimOwner(app)
    const secretValues = ["upstream-password", "tmdb-secret", "trakt-secret"]
    const created = await app.request("/api/dashboard/servers", {
      method: "POST",
      headers: { ...jsonHeaders(app.publicOrigin), cookie },
      body: JSON.stringify({
        name: "Acceptance server",
        endpoints: [
          { protocol: "https", host: "primary.example.com", port: null, path: "" },
          { protocol: "https", host: "secondary.example.com", port: null, path: "/emby" }
        ],
        username: "upstream-user",
        password: { _tag: "Set", value: secretValues[0] },
        userAgentPolicy: "fixed",
        userAgent: "Fixed/1",
        enabled: true
      })
    })
    expect(created.status).toBe(200)
    const createdBody = await created.clone().text()
    let server = await created.json() as {
      id: string
      generation: number
      endpoints: ReadonlyArray<{
        id: string
        protocol: "http" | "https"
        host: string
        port: number | null
        path: string
      }>
    }
    expect(server.endpoints.map(({ host, path }) => ({ host, path }))).toEqual([
      { host: "primary.example.com", path: "" },
      { host: "secondary.example.com", path: "/emby" }
    ])

    const verified = await app.request(`/api/dashboard/servers/${server.id}/test`, {
      method: "POST",
      headers: { origin: app.publicOrigin, cookie }
    })
    expect(verified.status).toBe(200)
    await expect(verified.json()).resolves.toMatchObject({
      reachable: true,
      catalogId: "setup-catalog-id",
      endpoints: [
        { reachable: true, catalogId: "setup-catalog-id", health: "healthy" },
        { reachable: true, catalogId: "setup-catalog-id", health: "healthy" }
      ]
    })

    const requests: Array<{ host: string; userAgent: string | null }> = []
    const upstreamFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      requests.push({ host: url.host, userAgent: request.headers.get("user-agent") })
      return url.hostname === "primary.example.com"
        ? new Response("Unavailable", { status: 503 })
        : Response.json({ Items: [], TotalRecordCount: 0 })
    }
    const upstream = makeUpstreamClientLayer({
      fetch: upstreamFetch,
      destinationPolicy: { platform: name === "workers" ? "workers" : "docker" }
    }).pipe(Layer.provide(app.repositories))
    const requestItems = (clientUserAgent?: string) => Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* UpstreamClient).request({
        serverId: server.id,
        generation: server.generation,
        path: "/Items",
        method: "GET",
        ...(clientUserAgent === undefined ? {} : { clientUserAgent })
      }, Schema.Unknown)
    }).pipe(Effect.provide(upstream)))
    const updatePolicy = async (
      userAgentPolicy: "fixed" | "client-preferred" | "passthrough",
      userAgent: string | null
    ) => {
      const response = await app.request(`/api/dashboard/servers/${server.id}`, {
        method: "PUT",
        headers: { ...jsonHeaders(app.publicOrigin), cookie },
        body: JSON.stringify({
          name: "Acceptance server",
          endpoints: server.endpoints,
          username: "upstream-user",
          password: { _tag: "Preserve" },
          userAgentPolicy,
          userAgent,
          enabled: true
        })
      })
      expect(response.status).toBe(200)
      server = await response.json() as typeof server
    }
    const expectUserAgents = async (client: string, background: string) => {
      const start = requests.length
      await requestItems("SenPlayer/9")
      await requestItems()
      expect(requests.slice(start)).toEqual([
        { host: "primary.example.com", userAgent: client },
        { host: "secondary.example.com", userAgent: client },
        { host: "primary.example.com", userAgent: background },
        { host: "secondary.example.com", userAgent: background }
      ])
    }

    await expectUserAgents("Fixed/1", "Fixed/1")
    await updatePolicy("client-preferred", "Preferred/1")
    await expectUserAgents("SenPlayer/9", "Preferred/1")
    await updatePolicy("passthrough", null)
    await expectUserAgents("SenPlayer/9", "oh-my-emby/0.0.0")

    const savedSettings = await app.request("/api/dashboard/metadata-settings", {
      method: "PUT",
      headers: { ...jsonHeaders(app.publicOrigin), cookie },
      body: JSON.stringify({ providers: [
        { id: "tmdb", enabled: true, order: 0, language: "en-US", credential: { _tag: "Set", value: secretValues[1] } },
        { id: "trakt", enabled: true, order: 1, language: null, credential: { _tag: "Set", value: secretValues[2] } }
      ] })
    })
    expect(savedSettings.status).toBe(200)
    const savedSettingsBody = await savedSettings.clone().text()
    expect(await savedSettings.clone().json()).toEqual({ providers: [
      { id: "tmdb", enabled: true, order: 0, language: "en-US", hasCredential: true, status: "ready" },
      { id: "trakt", enabled: true, order: 1, language: null, hasCredential: true, status: "ready" }
    ] })

    const reorderedSettings = await app.request("/api/dashboard/metadata-settings", {
      method: "PUT",
      headers: { ...jsonHeaders(app.publicOrigin), cookie },
      body: JSON.stringify({ providers: [
        { id: "trakt", enabled: true, order: 0, language: null, credential: { _tag: "Preserve" } },
        { id: "tmdb", enabled: true, order: 1, language: "en-US", credential: { _tag: "Preserve" } }
      ] })
    })
    expect(reorderedSettings.status).toBe(200)
    const reorderedSettingsBody = await reorderedSettings.clone().text()
    expect(await reorderedSettings.clone().json()).toEqual({ providers: [
      { id: "trakt", enabled: true, order: 0, language: null, hasCredential: true, status: "ready" },
      { id: "tmdb", enabled: true, order: 1, language: "en-US", hasCredential: true, status: "ready" }
    ] })

    const federation = await prepareFederation(app)
    const accessToken = await loginEmby(app)
    const detail = await app.request(`/Items/${federation.page.items[0]!.id}`, {
      headers: { authorization: `Bearer ${accessToken}`, "user-agent": "SenPlayer/9" }
    })
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      Name: "Trakt title",
      Overview: "Upstream overview"
    })

    const publicSettings = await app.request("/api/dashboard/metadata-settings", { headers: { cookie } })
    const publicServers = await app.request("/api/dashboard/servers", { headers: { cookie } })
    expect(publicSettings.status).toBe(200)
    expect(publicServers.status).toBe(200)
    await expect(publicSettings.clone().json()).resolves.toEqual({ providers: [
      { id: "trakt", enabled: true, order: 0, language: null, hasCredential: true, status: "ready" },
      { id: "tmdb", enabled: true, order: 1, language: "en-US", hasCredential: true, status: "degraded" }
    ] })
    const publicBodies = [
      createdBody,
      savedSettingsBody,
      reorderedSettingsBody,
      await publicSettings.text(),
      await publicServers.text()
    ].join("\n")
    for (const secret of secretValues) expect(publicBodies).not.toContain(secret)
  })

  it("fails closed when a credential-bearing provider response redirects", async () => {
    const cookie = await claimOwner(app)
    const secret = "tmdb-redirect-secret"
    const savedSettings = await app.request("/api/dashboard/metadata-settings", {
      method: "PUT",
      headers: { ...jsonHeaders(app.publicOrigin), cookie },
      body: JSON.stringify({ providers: [
        { id: "tmdb", enabled: true, order: 0, language: null, credential: { _tag: "Set", value: secret } },
        { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Clear" } }
      ] })
    })
    expect(savedSettings.status).toBe(200)

    const federation = await prepareFederation(app)
    const [record] = await useRepositories(app.repositories, (repositories) =>
      repositories.readCatalogItems([federation.page.items[0]!.id]))
    expect(record).toBeDefined()

    const requests: Array<Request> = []
    const metadataProviders = makeMetadataProvidersLayer({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return new Response(JSON.stringify({ movie_results: [{ title: secret }] }), {
          status: 302,
          headers: { location: "https://redirected.example.com/metadata" }
        })
      }
    }).pipe(Layer.provide(app.repositories))
    const refreshed = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).refresh(record!)
    }).pipe(Effect.provide(metadataProviders)))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.redirect).toBe("manual")
    expect(new URL(requests[0]!.url).origin).toBe("https://api.themoviedb.org")
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${secret}`)
    expect(refreshed.canonical.displayMetadata).toEqual(record!.canonical.displayMetadata)
    expect(JSON.stringify(refreshed)).not.toContain(secret)
    await useRepositories(app.repositories, (repositories) => Effect.gen(function*() {
      expect(yield* repositories.readExternalMetadata("tmdb", "imdb:title", "tt10")).toBeNull()
      expect((yield* repositories.readMetadataSettings()).find(({ id }) => id === "tmdb")?.status).toBe("degraded")
    }))
  })

  it("preserves repository encoding, source order, and applied migrations", async () => {
    await useRepositories(app.repositories, (repositories) => Effect.gen(function*() {
      yield* repositories.saveServer(serverFixture(0))
      yield* repositories.saveServer(serverFixture(1))
      yield* repositories.saveVirtualLibrary({
        id: "library-1" as any,
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        sources: [
          { serverId: "server-1" as any, sourceLibraryId: "movies-1" as any, sourceLibraryName: "One", mediaType: "movies", sourceOrder: 1, enabled: true },
          { serverId: "server-0" as any, sourceLibraryId: "movies-0" as any, sourceLibraryName: "Zero", mediaType: "movies", sourceOrder: 0, enabled: true }
        ]
      }, [
        { serverId: "server-1", generation: 1 },
        { serverId: "server-0", generation: 1 }
      ])
      expect((yield* repositories.resolveEligibleSources("library-1")).map(({ serverId }) => serverId))
        .toEqual(["server-0", "server-1"])
    }))
    await expect(app.inspectStorage()).resolves.toEqual({
      migrationNames: ["initial", "dashboard_alignment"],
      enabledEncoding: 1
    })
  })

  it.each(["/api/dashboard/not-a-route", "/dashboard/assets/missing.js"])(
    "keeps %s as a non-HTML 404",
    async (path) => {
      const response = await app.request(path, { headers: { accept: "text/html" } })
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type") ?? "").not.toContain("text/html")
    }
  )

  it("exact-merges versions while retaining a partial upstream failure", async () => {
    const scenario = await prepareFederation(app)
    expect(scenario.page.items).toHaveLength(1)
    expect(scenario.detailed?.mediaVersions).toHaveLength(2)
    expect(scenario.detailed?.incompleteSourceIds).toEqual(["server-2"])
  })

  it("answers favorite membership from local state without another source scan", async () => {
    const scenario = await prepareFederation(app)
    const canonicalId = scenario.page.items[0]!.id
    await useRepositories(app.repositories, (repositories) => Effect.gen(function*() {
      yield* repositories.writeUserStateAndTargets({
        canonicalId,
        patch: { favorite: true, positionTicks: 42 },
        updatedAtMs: 2_000
      })
      yield* repositories.invalidateStateDependentQueryGenerations()
    }))
    const callsBefore = scenario.listCalls()
    const favorites = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* Federation).list({
        ...scenario.query,
        deviceId: "favorites-device",
        filters: [{ field: "favorite" as const, value: true }]
      })
    }).pipe(Effect.provide(scenario.layer)))
    expect(favorites.items.map(({ id }) => id)).toEqual([canonicalId])
    expect(scenario.listCalls()).toBe(callsBefore)
  })

  it("recovers persisted outbox targets after reopening repositories", async () => {
    const scenario = await prepareFederation(app)
    await useRepositories(app.repositories, (repositories) => repositories.writeUserStateAndTargets({
      canonicalId: scenario.page.items[0]!.id,
      patch: { played: true, playCount: 1 },
      updatedAtMs: 2_000
    }))
    const claims = await useRepositories(app.reopenRepositories(), (repositories) =>
      repositories.claimOutboxTargets({ nowMs: 3_000, leaseOwner: `${name}-restart` }))
    expect(claims).toHaveLength(2)
  })

  it("routes PlaybackInfo video and subtitle URLs through the production runtime", async () => {
    await claimOwner(app)
    const accessToken = await loginEmby(app)
    const scenario = await prepareFederation(app)
    const infoResponse = await app.request(`/Items/${scenario.page.items[0]!.id}/PlaybackInfo`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(infoResponse.status).toBe(200)
    const info = (await infoResponse.json()) as {
      MediaSources: ReadonlyArray<{
        DirectStreamUrl?: string
        MediaStreams?: ReadonlyArray<{ DeliveryUrl?: string }>
      }>
    }
    const directStreamUrl = info.MediaSources[0]?.DirectStreamUrl
    const subtitleUrl = info.MediaSources[0]?.MediaStreams?.find(({ DeliveryUrl }) => DeliveryUrl)?.DeliveryUrl
    expect(directStreamUrl).toMatch(/^\/Videos\//)
    expect(subtitleUrl).toMatch(/^\/Videos\//)

    for (const prefix of ["", "/emby"]) {
      const video = await app.request(`${prefix}${directStreamUrl}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "manual"
      })
      expect(video.status, `${prefix || "root"} video`).toBe(302)
      expect(video.headers.get("cache-control")).toBe("private, no-store")
      expect((await video.arrayBuffer()).byteLength).toBe(0)

      const subtitle = await app.request(`${prefix}${subtitleUrl}`, {
        headers: { authorization: `Bearer ${accessToken}` }
      })
      expect(subtitle.status, `${prefix || "root"} subtitle`).toBe(503)
      await expect(subtitle.json()).resolves.toEqual({
        error: { code: "Unavailable", message: "Service unavailable" }
      })
    }
  })

  it.skipIf(name !== "docker")("redirects image URLs from the Bun production runtime", async () => {
    await claimOwner(app)
    const accessToken = await loginEmby(app)
    const scenario = await prepareFederation(app)

    for (const prefix of ["", "/emby"]) {
      const image = await app.request(`${prefix}/Items/${scenario.page.items[0]!.id}/Images/Primary`, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "manual"
      })

      expect(image.status, `${prefix || "root"} image`).toBe(302)
      expect(image.headers.get("cache-control")).toBe("private, no-store")
      expect(image.headers.get("location")).toBe(
        "https://server-0.example.com/Items/server-0-movie/Images/Primary?api_key=token-0"
      )
    }
  })
})
