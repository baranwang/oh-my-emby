import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js"
import type { CanonicalItemView, FederatedQuery } from "../src/core/federation.js"

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "sen-device",
  deviceName: "SenPlayer"
}

const item = (
  id: string,
  type = "Movie",
  extra: Partial<CanonicalItemView> = {}
): CanonicalItemView => ({
  id,
  itemType: type,
  displayMetadata: {
    Name: `${type} ${id}`,
    UserData: { IsFavorite: false, Played: true },
    MediaSources: [{ Id: "untrusted-upstream-version" }]
  },
  mediaVersions: [{
    id: `version-${id}`,
    sourceItemId: `source-${id}`,
    serverGeneration: 1,
    upstreamMediaSourceId: `upstream-${id}`,
    label: "Server A · 1080p",
    capabilities: {
      Id: "upstream-id",
      Container: "mkv",
      RunTimeTicks: 10_000,
      Path: "https://upstream.example/video?api_key=private-token",
      DirectStreamUrl: "/Videos/upstream-id/stream?api_key=private-token"
    },
    streams: [{ Index: 0, Type: "Video" }],
    updatedAtMs: 1_000
  }],
  userState: {
    canonicalId: id,
    revision: 3,
    played: false,
    favorite: true,
    playCount: 2,
    positionTicks: 42,
    lastPlayedVersionId: `version-${id}`,
    updatedAtMs: 1_000
  },
  incompleteSourceIds: [],
  ...extra
})

const services = (overrides: Partial<EmbyServices> = {}): EmbyServices => ({
  config: { serverId: "virtual-server", serverName: "Oh My Emby", version: "0.0.0" },
  now: () => 1_234,
  auth: {
    loginEmby: () => Effect.die("unused"),
    authenticateEmby: () => Effect.succeed(principal)
  },
  federation: {
    list: () => Effect.succeed({
      items: [item("movie-1")],
      totalRecordCount: 1,
      exhausted: true,
      incompleteSourceIds: []
    }),
    search: () => Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    detail: (id) => Effect.succeed(item(id))
  },
  userState: {
    write: () => Effect.die("unused"),
    recordPlaybackEvent: () => Effect.die("unused")
  },
  libraries: {
    list: () => Effect.succeed([{
      id: "library-1" as any,
      name: "Movies",
      mediaType: "movies",
      enabled: true,
      sources: []
    }])
  },
  playback: {
    getInfo: () => Effect.succeed({ playSessionId: "play-session", mediaSources: [{ Id: "version-movie-1" }] })
  },
  ...overrides
})

const get = (path: string, token = "token") => new Request(`https://local${path}`, {
  headers: { authorization: `Bearer ${token}` }
})

describe("Emby catalog routes", () => {
  it.each(["", "/emby"])("returns views with the %s alias prefix", async (prefix) => {
    const response = await Effect.runPromise(makeEmbyHandler(services())(
      get(`${prefix}/Users/owner/Views`)
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      Items: [{
        Id: "library-1",
        Name: "Movies",
        Type: "CollectionFolder",
        CollectionType: "movies"
      }],
      TotalRecordCount: 1,
      StartIndex: 0
    })
  })

  it.each(["", "/emby"])("overlays canonical state and versions for %s list routes", async (prefix) => {
    const response = await Effect.runPromise(makeEmbyHandler(services())(
      get(`${prefix}/Users/owner/Items?ParentId=library-1&StartIndex=0&Limit=20`)
    ))

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({
      Items: [{
        Id: "movie-1",
        Type: "Movie",
        UserData: {
          ItemId: "movie-1",
          IsFavorite: true,
          Played: false,
          PlayCount: 2,
          PlaybackPositionTicks: 42
        },
        MediaSources: [{
          Id: "version-movie-1",
          Name: "Server A · 1080p",
          Container: "mkv",
          MediaStreams: [{ Index: 0, Type: "Video" }]
        }]
      }],
      StartIndex: 0,
      TotalRecordCount: 1
    })
    expect(body.Items[0].MediaSources[0]).not.toHaveProperty("Path")
    expect(body.Items[0].MediaSources[0]).not.toHaveProperty("DirectStreamUrl")
    expect(JSON.stringify(body)).not.toContain("private-token")
  })

  it("decodes search, sort, fields, and local filters before Federation", async () => {
    let observed: (FederatedQuery & { readonly searchTerm?: string }) | undefined
    const app = makeEmbyHandler(services({
      federation: {
        list: () => Effect.die("unused"),
        search: (query) => {
          observed = query
          return Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] })
        },
        detail: () => Effect.succeed(null)
      }
    }))
    const response = await Effect.runPromise(app(get(
      "/Users/owner/Items?ParentId=library-1&StartIndex=2&Limit=10" +
      "&SearchTerm=needle&SortBy=SortName,ProductionYear&SortOrder=Ascending,Descending" +
      "&Fields=Overview,MediaSources&Filters=IsFavorite,IsResumable&IncludeItemTypes=Movie"
    )))

    expect(response.status).toBe(200)
    expect(observed).toEqual({
      userId: "owner",
      deviceId: "sen-device",
      virtualLibraryId: "library-1",
      startIndex: 2,
      limit: 10,
      searchTerm: "needle",
      sort: [
        { field: "SortName", direction: "Ascending" },
        { field: "ProductionYear", direction: "Descending" }
      ],
      fields: ["Overview", "MediaSources"],
      filters: [
        { field: "favorite", value: true },
        { field: "resume", value: true },
        { field: "itemType", value: "Movie" }
      ]
    })
  })

  it.each(["Movie", "Series", "Season", "Episode"])(
    "returns %s details with canonical local state",
    async (type) => {
      const id = type.toLowerCase()
      const app = makeEmbyHandler(services({
        federation: {
          list: () => Effect.die("unused"),
          search: () => Effect.die("unused"),
          detail: () => Effect.succeed(item(id, type))
        }
      }))
      const response = await Effect.runPromise(app(get(`/Users/owner/Items/${id}`)))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        Id: id,
        Type: type,
        UserData: { ItemId: id, IsFavorite: true }
      })
    }
  )

  it("preserves provisional count corrections exactly", async () => {
    let total = 21
    const app = makeEmbyHandler(services({
      federation: {
        list: () => Effect.succeed({
          items: [item("movie-1")],
          totalRecordCount: total,
          exhausted: total === 1,
          incompleteSourceIds: []
        }),
        search: () => Effect.die("unused"),
        detail: () => Effect.succeed(null)
      }
    }))
    const first = await Effect.runPromise(app(get(
      "/Users/owner/Items?ParentId=library-1&StartIndex=0&Limit=20"
    )))
    total = 1
    const corrected = await Effect.runPromise(app(get(
      "/Users/owner/Items?ParentId=library-1&StartIndex=0&Limit=20"
    )))

    expect((await first.json() as any).TotalRecordCount).toBe(21)
    expect((await corrected.json() as any).TotalRecordCount).toBe(1)
  })

  it("returns JSON 404 for unknown IDs and rejects malformed query values before core calls", async () => {
    let calls = 0
    const app = makeEmbyHandler(services({
      federation: {
        list: () => {
          calls++
          return Effect.die("not reached")
        },
        search: () => Effect.die("unused"),
        detail: () => Effect.succeed(null)
      }
    }))

    const missing = await Effect.runPromise(app(get("/Users/owner/Items/missing")))
    const invalid = await Effect.runPromise(app(get(
      "/Users/owner/Items?ParentId=library-1&StartIndex=-1&Limit=nope"
    )))

    expect(missing.status).toBe(404)
    expect(missing.headers.get("content-type")).toContain("application/json")
    expect(invalid.status).toBe(400)
    expect(calls).toBe(0)
  })

  it("rejects a token user path mismatch", async () => {
    const response = await Effect.runPromise(makeEmbyHandler(services())(
      get("/Users/not-owner/Views")
    ))
    expect(response.status).toBe(403)
  })

  it("delegates PlaybackInfo without implementing media resolution in the protocol layer", async () => {
    let canonicalId = ""
    const app = makeEmbyHandler(services({
      playback: {
        getInfo: (id) => {
          canonicalId = id
          return Effect.succeed({
            playSessionId: "play-session",
            mediaSources: [{ Id: "stable-version" }]
          })
        }
      }
    }))
    const response = await Effect.runPromise(app(new Request(
      "https://local/Items/movie-1/PlaybackInfo",
      { method: "POST", headers: { authorization: "Bearer token" } }
    )))

    expect(response.status).toBe(200)
    expect(canonicalId).toBe("movie-1")
    await expect(response.json()).resolves.toEqual({
      PlaySessionId: "play-session",
      MediaSources: [{ Id: "stable-version" }]
    })
  })
})
