import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js"
import { Federation, type CanonicalItemView } from "../src/core/federation.js"
import type { EligibleSource, SourceItemRecord, SourceMediaVersion } from "../src/core/model.js"
import { Playback, makePlaybackLayer } from "../src/core/playback.js"
import { Repositories, type CatalogItemRecord } from "../src/core/repositories.js"
import { UpstreamClient } from "../src/core/upstream-client.js"

const source = (serverId: string, id: string, upstreamItemId: string, generation = 1): SourceItemRecord => ({
  id,
  serverId,
  catalogNamespace: `catalog:${serverId}`,
  serverGeneration: generation,
  sourceLibraryId: `library:${serverId}`,
  upstreamItemId,
  itemType: "Movie",
  canonicalId: "movie-1",
  quarantineReason: null,
  createdAtMs: 1,
  updatedAtMs: 1
})

const version = (
  id: string,
  sourceItemId: string,
  upstreamMediaSourceId: string,
  streams: SourceMediaVersion["streams"] = []
): SourceMediaVersion => ({
  id,
  sourceItemId,
  serverGeneration: 1,
  upstreamMediaSourceId,
  label: id,
  capabilities: {
    Container: "mkv",
    SupportsTranscoding: true,
    TranscodingUrl: "/Videos/private/transcode"
  },
  streams,
  updatedAtMs: 1
})

const eligible = (serverId: string, sourceOrder: number): EligibleSource => ({
  virtualLibraryId: "library-1" as any,
  serverId,
  sourceLibraryId: `library:${serverId}` as any,
  sourceLibraryName: serverId,
  mediaType: "movies",
  sourceOrder,
  enabled: true,
  catalogNamespace: `catalog:${serverId}`,
  verifiedCatalogId: `verified:${serverId}`,
  serverGeneration: 1,
  baseUrl: `https://${serverId}.example.com`,
  username: "upstream",
  password: null,
  accessToken: `token-${serverId}`,
  accessTokenExpiresAtMs: null,
  userAgent: "test"
})

const makeFixture = (options: {
  versions?: ReadonlyArray<SourceMediaVersion>
  sources?: ReadonlyArray<SourceItemRecord>
  eligible?: ReadonlyArray<EligibleSource>
  fail?: ReadonlySet<string>
  binding?: (serverId: string) => boolean
  clientUsable?: boolean
} = {}) => {
  const sourceA = source("a", "source-a", "item-a")
  const sourceB = source("b", "source-b", "item-b")
  const versions = options.versions ?? [
    version("version-b", sourceB.id, "media-b"),
    version("version-a-2", sourceA.id, "media-a-2"),
    version("version-a-1", sourceA.id, "media-a-1", [
      { Index: 7, Type: "Audio", Codec: "aac" },
      { Index: 11, Type: "Subtitle", Codec: "srt", IsExternal: true, IsTextSubtitleStream: true }
    ])
  ]
  const sourceItems = options.sources ?? [sourceB, sourceA]
  const eligibleSources = options.eligible ?? [eligible("b", 1), eligible("a", 0)]
  const record: CatalogItemRecord = {
    canonical: {
      id: "movie-1",
      itemType: "Movie",
      identityState: "exact",
      displayMetadata: { Name: "Movie" },
      createdAtMs: 1,
      updatedAtMs: 1
    },
    claims: [],
    sourceItems,
    mediaVersions: versions,
    userState: null
  }
  const item: CanonicalItemView = {
    id: "movie-1",
    itemType: "Movie",
    displayMetadata: record.canonical.displayMetadata,
    mediaVersions: versions,
    userState: null,
    incompleteSourceIds: []
  }
  const resolutions: Array<string> = []
  let videoBodyReads = 0
  const repositories = Layer.succeed(Repositories, Repositories.of({
    readCatalogItems: () => Effect.succeed([record]),
    resolveEligibleSourcesForCanonical: () => Effect.succeed(eligibleSources),
    isSourceEligible: (serverId: string) => Effect.succeed(options.binding?.(serverId) ?? true)
  } as any))
  const federation = Layer.succeed(Federation, Federation.of({
    enrichVersions: () => Effect.succeed(item),
    lookupMembership: () => Effect.succeed({ item, version: null })
  } as any))
  const upstream = Layer.succeed(UpstreamClient, UpstreamClient.of({
    resolvePlayback: (candidate: SourceMediaVersion) => {
      resolutions.push(candidate.id)
      if (options.fail?.has(candidate.id)) {
        return Effect.fail({ _tag: "UpstreamUnavailable", serverId: candidate.id } as any)
      }
      const details = candidate.capabilities as { url: string; serverId: string }
      return Effect.succeed({ serverId: details.serverId, generation: 1, url: details.url })
    }
  } as any))
  const layer = makePlaybackLayer({
    sessionId: () => "play-session",
    isClientUsableResource: () => options.clientUsable ?? false
  }).pipe(
    Layer.provide(Layer.mergeAll(repositories, federation, upstream))
  )
  const run = <A>(effect: Effect.Effect<A, any, Playback>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { item, record, run, resolutions, get videoBodyReads() { return videoBodyReads }, readVideo: () => videoBodyReads++ }
}

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "device",
  deviceName: "client"
}

const services = (playback: EmbyServices["playback"], item: CanonicalItemView): EmbyServices => ({
  config: { serverId: "virtual", serverName: "Virtual", version: "0" },
  now: () => 1,
  auth: {
    loginEmby: () => Effect.die("unused"),
    authenticateEmby: () => Effect.succeed(principal)
  },
  federation: {
    list: () => Effect.die("unused"),
    search: () => Effect.die("unused"),
    detail: () => Effect.succeed(item),
    lookupMembership: () => Effect.succeed({ item, version: null })
  },
  userState: { write: () => Effect.die("unused"), recordPlaybackEvent: () => Effect.die("unused") },
  libraries: { list: () => Effect.succeed([]) },
  playback
})

describe("playback decisions", () => {
  it("redirects the selected version without reading video bytes", async () => {
    const fixture = makeFixture()
    const playback = await fixture.run(Playback)
    const response = await Effect.runPromise(makeEmbyHandler(services(playback, fixture.item))(new Request(
      "https://local/Videos/movie-1/stream?MediaSourceId=version-b",
      { headers: { authorization: "Bearer local-token" } }
    )))

    expect(response.status).toBe(302)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("location")).toBe(
      "https://b.example.com/Videos/item-b/stream?MediaSourceId=media-b&Static=true&api_key=token-b"
    )
    expect(fixture.videoBodyReads).toBe(0)
  })

  it("uses stable source, server, item, and media-source fallback order and isolates failures", async () => {
    const fixture = makeFixture({ fail: new Set(["version-a-1"]) })
    const playback = await fixture.run(Playback)
    const resolved = await Effect.runPromise(playback.resolveVideoRedirect({ canonicalId: "movie-1" }))

    expect(fixture.resolutions).toEqual(["version-a-1", "version-a-2"])
    expect(resolved.href).toContain("MediaSourceId=media-a-2")
  })

  it("keeps multiple media sources from one upstream item independently selectable", async () => {
    const sourceA = source("a", "source-a", "item-a")
    const fixture = makeFixture({
      sources: [sourceA],
      eligible: [eligible("a", 0)],
      versions: [
        version("cut-a", sourceA.id, "media-a"),
        version("cut-b", sourceA.id, "media-b")
      ]
    })
    const playback = await fixture.run(Playback)

    const first = await Effect.runPromise(playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "cut-a" }))
    const second = await Effect.runPromise(playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "cut-b" }))
    expect(first.href).toContain("MediaSourceId=media-a")
    expect(second.href).toContain("MediaSourceId=media-b")
  })

  it("rejects obsolete generations and bindings removed immediately before resolution", async () => {
    const stale = source("a", "source-a", "item-a", 2)
    const obsolete = makeFixture({
      sources: [stale],
      eligible: [{ ...eligible("a", 0), serverGeneration: 2 }],
      versions: [version("stale", stale.id, "media-a")]
    })
    const removed = makeFixture({ binding: () => false })

    await expect(obsolete.run(Playback).then((playback) => Effect.runPromise(
      playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "stale" })
    ))).rejects.toMatchObject({ _tag: "PlaybackUnavailable" })
    await expect(removed.run(Playback).then((playback) => Effect.runPromise(
      playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "version-a-1" })
    ))).rejects.toMatchObject({ _tag: "PlaybackUnavailable" })
  })

  it("preserves track indexes, rewrites local entry points, and advertises no transcoding", async () => {
    const fixture = makeFixture()
    const info = await fixture.run(Effect.gen(function*() {
      const playback = yield* Playback
      return yield* playback.getInfo("movie-1")
    }))

    expect(info.playSessionId).toBe("play-session")
    expect(info.mediaSources).toHaveLength(3)
    const selected = info.mediaSources.find((entry: any) => entry.Id === "version-a-1") as any
    expect(selected).toMatchObject({
      Path: "/Videos/movie-1/stream?MediaSourceId=version-a-1",
      DirectStreamUrl: "/Videos/movie-1/stream?MediaSourceId=version-a-1",
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      MediaStreams: [{ Index: 7 }, { Index: 11 }]
    })
    expect(selected).not.toHaveProperty("TranscodingUrl")
    expect(JSON.stringify(info)).not.toContain("api_key")
  })

  it("resolves only registered external text subtitles by version and stream index", async () => {
    const sourceA = source("a", "source-a", "item-a")
    const fixture = makeFixture({
      sources: [sourceA],
      eligible: [eligible("a", 0)],
      versions: [version("version-a", sourceA.id, "media-a", [
        { Index: 2, Type: "Subtitle", Codec: "srt", IsExternal: true, IsTextSubtitleStream: true },
        { Index: 3, Type: "Subtitle", Codec: "pgs", IsExternal: true, IsTextSubtitleStream: false },
        { Index: 4, Type: "Subtitle", Codec: "srt", IsExternal: false, IsTextSubtitleStream: true }
      ])]
    })
    const playback = await fixture.run(Playback)

    await expect(Effect.runPromise(playback.resolveSubtitle({
      canonicalId: "movie-1",
      mediaSourceId: "version-a",
      streamIndex: 2,
      format: "srt"
    }))).resolves.toMatchObject({
      _tag: "Proxy",
      request: {
        key: "subtitle:movie-1:version-a:2:srt",
        kind: "subtitle",
        maxBytes: 5 * 1024 * 1024
      }
    })
    await expect(Effect.runPromise(playback.resolveSubtitle({
      canonicalId: "movie-1",
      mediaSourceId: "version-a",
      streamIndex: 3,
      format: "pgs"
    }))).rejects.toMatchObject({ _tag: "ResourceRejected" })
    await expect(Effect.runPromise(playback.resolveSubtitle({
      canonicalId: "movie-1",
      mediaSourceId: "version-a",
      streamIndex: 4,
      format: "srt"
    }))).rejects.toMatchObject({ _tag: "ResourceRejected" })
  })

  it("builds registered image requests from canonical source identity", async () => {
    const fixture = makeFixture()
    const playback = await fixture.run(Playback)
    const decision = await Effect.runPromise(playback.resolveImage({
      canonicalId: "movie-1",
      imageType: "Primary",
      imageIndex: 0
    }))

    expect(decision).toMatchObject({
      _tag: "Proxy",
      request: {
        key: "image:movie-1:Primary:0:version-a-1",
        kind: "image",
        maxBytes: 20 * 1024 * 1024
      }
    })
    expect(decision._tag === "Proxy" && decision.request.url.href).toBe(
      "https://a.example.com/Items/item-a/Images/Primary/0?api_key=token-a"
    )
  })

  it("redirects auxiliary resources only when platform composition marks them client-usable", async () => {
    const fixture = makeFixture({ clientUsable: true })
    const playback = await fixture.run(Playback)

    await expect(Effect.runPromise(playback.resolveImage({
      canonicalId: "movie-1",
      imageType: "Primary"
    }))).resolves.toMatchObject({
      _tag: "Redirect",
      location: new URL("https://a.example.com/Items/item-a/Images/Primary?api_key=token-a")
    })
  })
})
