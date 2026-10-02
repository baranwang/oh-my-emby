import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js";
import { Federation, type CanonicalItemView } from "../src/core/federation.js";
import { MetadataProviders } from "../src/core/metadata-providers.js";
import type { EligibleSource, SourceItemRecord, SourceMediaVersion } from "../src/core/model.js";
import { Playback, makePlaybackLayer, serveRegisteredResource } from "../src/core/playback.js";
import type { CachedResource, CountedResource } from "../src/core/resource-cache.js";
import { Repositories, type CatalogItemRecord } from "../src/core/repositories.js";
import { UpstreamClient, makeUpstreamClientLayer } from "../src/core/upstream-client.js";

const source = (
  serverId: string,
  id: string,
  upstreamItemId: string,
  generation = 1,
): SourceItemRecord => ({
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
  updatedAtMs: 1,
});

const version = (
  id: string,
  sourceItemId: string,
  upstreamMediaSourceId: string,
  streams: SourceMediaVersion["streams"] = [],
): SourceMediaVersion => ({
  id,
  sourceItemId,
  serverGeneration: 1,
  upstreamMediaSourceId,
  label: id,
  capabilities: {
    Container: "mkv",
    SupportsTranscoding: true,
    TranscodingUrl: "/Videos/private/transcode",
  },
  streams,
  updatedAtMs: 1,
});

const eligible = (serverId: string, sourceOrder: number): EligibleSource => ({
  virtualLibraryId: "library-1" as any,
  serverId,
  name: serverId,
  sourceLibraryId: `library:${serverId}` as any,
  sourceLibraryName: serverId,
  mediaType: "movies",
  sourceOrder,
  enabled: true,
  catalogNamespace: `catalog:${serverId}`,
  verifiedCatalogId: `verified:${serverId}`,
  serverGeneration: 1,
  endpoints: [
    {
      id: `endpoint-${serverId}`,
      protocol: "https",
      host: `${serverId}.example.com`,
      port: null,
      path: "",
      displayUrl: `https://${serverId}.example.com`,
      verifiedCatalogId: `verified:${serverId}`,
      health: "healthy",
      lastSuccessAtMs: 1,
      order: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ],
  baseUrl: `https://${serverId}.example.com`,
  username: "upstream",
  password: null,
  accessToken: `token-${serverId}`,
  accessTokenExpiresAtMs: null,
  userAgentPolicy: "fixed",
  userAgent: "test",
});

const makeFixture = (
  options: {
    versions?: ReadonlyArray<SourceMediaVersion>;
    sources?: ReadonlyArray<SourceItemRecord>;
    eligible?: ReadonlyArray<EligibleSource>;
    fail?: ReadonlySet<string>;
    binding?: (serverId: string) => boolean;
    clientUsable?: boolean;
    externalImage?: URL | null;
    imageAfterRefresh?: URL;
    resourceRequest?: () => Effect.Effect<Response, any>;
    fetchArtwork?: typeof fetch;
    imageRedirect?: URL;
  } = {},
) => {
  const sourceA = source("a", "source-a", "item-a");
  const sourceB = source("b", "source-b", "item-b");
  const versions = options.versions ?? [
    version("version-b", sourceB.id, "media-b"),
    version("version-a-2", sourceA.id, "media-a-2"),
    version("version-a-1", sourceA.id, "media-a-1", [
      { Index: 7, Type: "Audio", Codec: "aac" },
      { Index: 11, Type: "Subtitle", Codec: "srt", IsExternal: true, IsTextSubtitleStream: true },
    ]),
  ];
  const sourceItems = options.sources ?? [sourceB, sourceA];
  const eligibleSources = options.eligible ?? [eligible("b", 1), eligible("a", 0)];
  const record: CatalogItemRecord = {
    canonical: {
      id: "movie-1",
      itemType: "Movie",
      identityState: "exact",
      displayMetadata: { Name: "Movie" },
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    claims: [],
    sourceItems,
    mediaVersions: versions,
    userState: null,
  };
  const item: CanonicalItemView = {
    id: "movie-1",
    itemType: "Movie",
    displayMetadata: record.canonical.displayMetadata,
    mediaVersions: versions,
    userState: null,
    incompleteSourceIds: [],
  };
  const resolutions: Array<string> = [];
  const redirects: Array<string> = [];
  const clientUserAgents: Array<string | undefined> = [];
  let videoBodyReads = 0;
  let metadataRefreshes = 0;
  const repositories = Layer.succeed(
    Repositories,
    Repositories.of({
      readCatalogItems: () => Effect.succeed([record]),
      resolveEligibleSourcesForCanonical: () => Effect.succeed(eligibleSources),
      isSourceEligible: (serverId: string) => Effect.succeed(options.binding?.(serverId) ?? true),
    } as any),
  );
  const federation = Layer.succeed(
    Federation,
    Federation.of({
      enrichVersions: () => Effect.succeed(item),
      lookupMembership: () => Effect.succeed({ item, version: null }),
    } as any),
  );
  const metadataProviders = Layer.succeed(
    MetadataProviders,
    MetadataProviders.of({
      refresh: (record) =>
        Effect.sync(() => {
          metadataRefreshes++;
          return record;
        }),
      overlayCached: (record) => Effect.succeed(record),
      resolveCachedImage: () =>
        Effect.succeed(
          options.externalImage ??
            (metadataRefreshes > 0 ? (options.imageAfterRefresh ?? null) : null),
        ),
    }),
  );
  const upstream = Layer.succeed(
    UpstreamClient,
    UpstreamClient.of({
      resolvePlayback: (candidate: SourceMediaVersion) => {
        resolutions.push(candidate.id);
        if (options.fail?.has(candidate.id)) {
          return Effect.fail({ _tag: "UpstreamUnavailable", serverId: candidate.id } as any);
        }
        const details = candidate.capabilities as { url: string; serverId: string };
        return Effect.succeed({ serverId: details.serverId, generation: 1, url: details.url });
      },
      resolvePlaybackRedirect: (resolved: {
        readonly url: string;
        readonly clientUserAgent?: string;
      }) => {
        redirects.push(resolved.url);
        clientUserAgents.push(resolved.clientUserAgent);
        return Effect.succeed(
          new URL(
            new URL(resolved.url).pathname.includes("/Images/")
              ? (options.imageRedirect?.href ?? "https://image.tmdb.org/t/p/w780/episode.jpg")
              : `https://cdn.example.com/${new URL(resolved.url).searchParams.get("MediaSourceId")}`,
          ),
        );
      },
      requestResource: (request: { readonly clientUserAgent?: string }) => {
        clientUserAgents.push(request.clientUserAgent);
        return (
          options.resourceRequest?.() ??
          Effect.succeed(
            new Response("image", {
              headers: { "content-type": "image/png" },
            }),
          )
        );
      },
    } as any),
  );
  const layer = makePlaybackLayer({
    sessionId: () => "play-session",
    ...(options.fetchArtwork === undefined ? {} : { fetchArtwork: options.fetchArtwork }),
    isClientUsableResource: () => options.clientUsable ?? false,
  }).pipe(Layer.provide(Layer.mergeAll(repositories, federation, upstream, metadataProviders)));
  const run = <A>(effect: Effect.Effect<A, any, Playback>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return {
    item,
    record,
    run,
    resolutions,
    redirects,
    clientUserAgents,
    get videoBodyReads() {
      return videoBodyReads;
    },
    get metadataRefreshes() {
      return metadataRefreshes;
    },
    readVideo: () => videoBodyReads++,
  };
};

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "device",
  deviceName: "client",
};

const services = (playback: EmbyServices["playback"], item: CanonicalItemView): EmbyServices => ({
  config: { serverId: "virtual", serverName: "Virtual", version: "0" },
  now: () => 1,
  auth: {
    loginEmby: () => Effect.die("unused"),
    authenticateEmby: () => Effect.succeed(principal),
  },
  federation: {
    list: () => Effect.die("unused"),
    search: () => Effect.die("unused"),
    detail: () => Effect.succeed(item),
    lookupMembership: () => Effect.succeed({ item, version: null }),
  },
  userState: { write: () => Effect.die("unused"), recordPlaybackEvent: () => Effect.die("unused") },
  libraries: { list: () => Effect.succeed([]) },
  playback,
});

describe("playback decisions", () => {
  it("authorizes the connected address at the registered-resource transport boundary", async () => {
    const server = {
      id: "server-1",
      catalogNamespace: "catalog:server-1",
      verifiedCatalogId: "verified:server-1",
      verifiedBaseUrl: "https://example.com",
      generation: 1,
      name: "Server",
      endpoints: [
        {
          id: "endpoint-1",
          protocol: "https",
          host: "example.com",
          port: null,
          path: "",
          displayUrl: "https://example.com",
          verifiedCatalogId: "verified:server-1",
          health: "healthy",
          lastSuccessAtMs: 1,
          order: 0,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
      baseUrl: "https://example.com",
      username: "owner",
      password: null,
      accessToken: "token",
      accessTokenExpiresAtMs: null,
      upstreamUserId: "upstream-owner",
      userAgentPolicy: "fixed",
      userAgent: "test",
      enabled: true,
      health: "healthy",
      lastSuccessAtMs: 1,
      deletedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    } as any;
    const repositories = Layer.succeed(
      Repositories,
      Repositories.of({
        getServer: () => Effect.succeed(server),
      } as any),
    );
    const allowedFor = async (
      destinationPolicy: Parameters<typeof makeUpstreamClientLayer>[0]["destinationPolicy"],
      address: string,
    ) => {
      let allowed: boolean | undefined;
      const layer = makeUpstreamClientLayer({
        fetch: () => Promise.reject(new Error("control fetch must not run")),
        destinationPolicy,
        fetchRegisteredResource: async (_request, context) => {
          allowed = context.isConnectedAddressAllowed(address);
          return new Response(null);
        },
      }).pipe(Layer.provide(repositories));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const upstream = yield* UpstreamClient;
            return yield* upstream.requestResource({
              serverId: "server-1",
              generation: 1,
              url: new URL("https://example.com/Items/item/Images/Primary"),
              accept: ["image/png"],
            });
          }),
        ).pipe(Effect.provide(layer)),
      );
      return allowed;
    };

    await expect(allowedFor({ platform: "workers" }, "203.0.113.9")).resolves.toBe(true);
    await expect(allowedFor({ platform: "workers" }, "127.0.0.1")).resolves.toBe(false);
    await expect(allowedFor({ platform: "workers" }, "not-an-ip")).resolves.toBe(false);
    await expect(allowedFor({ platform: "docker" }, "192.168.1.20")).resolves.toBe(true);

    const perHopAllowed: Array<boolean> = [];
    const redirectLayer = makeUpstreamClientLayer({
      fetch: () => Promise.reject(new Error("control fetch must not run")),
      destinationPolicy: { platform: "docker" },
      fetchRegisteredResource: async (request, context) => {
        perHopAllowed.push(context.isConnectedAddressAllowed("192.168.1.20"));
        return request.url.startsWith("https://example.com/")
          ? new Response(null, {
              status: 302,
              headers: { location: "https://cdn.example.com/image" },
            })
          : new Response(null);
      },
    }).pipe(Layer.provide(repositories));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const upstream = yield* UpstreamClient;
          return yield* upstream.requestResource({
            serverId: "server-1",
            generation: 1,
            url: new URL("https://example.com/Items/item/Images/Primary"),
            accept: ["image/png"],
          });
        }),
      ).pipe(Effect.provide(redirectLayer)),
    );
    expect(perHopAllowed).toEqual([true, true]);
  });

  it("brokers the selected version without reading video bytes", async () => {
    const fixture = makeFixture();
    const playback = await fixture.run(Playback);
    const response = await Effect.runPromise(
      makeEmbyHandler(services(playback, fixture.item))(
        new Request("https://local/Videos/movie-1/stream?MediaSourceId=version-b", {
          headers: { authorization: "Bearer local-token", "user-agent": "Client/1" },
        }),
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBe("https://cdn.example.com/media-b");
    expect(fixture.redirects).toEqual([
      "https://b.example.com/Videos/item-b/stream?MediaSourceId=media-b&Static=true&api_key=token-b",
    ]);
    expect(fixture.clientUserAgents).toEqual(["Client/1"]);
    expect(fixture.videoBodyReads).toBe(0);
  });

  it("builds playback URLs from the first healthy same-catalog endpoint", async () => {
    const sourceA = source("a", "source-a", "item-a");
    const upstream = eligible("a", 0);
    const fixture = makeFixture({
      sources: [sourceA],
      eligible: [
        {
          ...upstream,
          endpoints: [
            {
              ...upstream.endpoints[0]!,
              id: "endpoint-degraded",
              host: "degraded.example.com",
              displayUrl: "https://degraded.example.com" as any,
              health: "degraded",
              order: 0,
            },
            {
              ...upstream.endpoints[0]!,
              id: "endpoint-healthy",
              host: "healthy.example.com",
              displayUrl: "https://healthy.example.com" as any,
              order: 1,
            },
          ],
        },
      ],
      versions: [version("version-a", sourceA.id, "media-a")],
    });
    const playback = await fixture.run(Playback);

    await Effect.runPromise(
      playback.resolveVideoRedirect({
        canonicalId: "movie-1",
        mediaSourceId: "version-a",
      }),
    );
    expect(fixture.redirects).toEqual([
      "https://healthy.example.com/Videos/item-a/stream?MediaSourceId=media-a&Static=true&api_key=token-a",
    ]);
  });

  it("uses stable source, server, item, and media-source fallback order and isolates failures", async () => {
    const fixture = makeFixture({ fail: new Set(["version-a-1"]) });
    const playback = await fixture.run(Playback);
    const resolved = await Effect.runPromise(
      playback.resolveVideoRedirect({ canonicalId: "movie-1" }),
    );

    expect(fixture.resolutions).toEqual(["version-a-1", "version-a-2"]);
    expect(resolved.href).toBe("https://cdn.example.com/media-a-2");
  });

  it("keeps multiple media sources from one upstream item independently selectable", async () => {
    const sourceA = source("a", "source-a", "item-a");
    const fixture = makeFixture({
      sources: [sourceA],
      eligible: [eligible("a", 0)],
      versions: [version("cut-a", sourceA.id, "media-a"), version("cut-b", sourceA.id, "media-b")],
    });
    const playback = await fixture.run(Playback);

    const first = await Effect.runPromise(
      playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "cut-a" }),
    );
    const second = await Effect.runPromise(
      playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "cut-b" }),
    );
    expect(first.href).toBe("https://cdn.example.com/media-a");
    expect(second.href).toBe("https://cdn.example.com/media-b");
  });

  it("rejects obsolete generations and bindings removed immediately before resolution", async () => {
    const stale = source("a", "source-a", "item-a", 2);
    const obsolete = makeFixture({
      sources: [stale],
      eligible: [{ ...eligible("a", 0), serverGeneration: 2 }],
      versions: [version("stale", stale.id, "media-a")],
    });
    const removed = makeFixture({ binding: () => false });

    await expect(
      obsolete
        .run(Playback)
        .then((playback) =>
          Effect.runPromise(
            playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "stale" }),
          ),
        ),
    ).rejects.toMatchObject({ _tag: "PlaybackUnavailable" });
    await expect(
      removed
        .run(Playback)
        .then((playback) =>
          Effect.runPromise(
            playback.resolveVideoRedirect({ canonicalId: "movie-1", mediaSourceId: "version-a-1" }),
          ),
        ),
    ).rejects.toMatchObject({ _tag: "PlaybackUnavailable" });
  });

  it("preserves track indexes, rewrites local entry points, and advertises no transcoding", async () => {
    const fixture = makeFixture();
    const info = await fixture.run(
      Effect.gen(function* () {
        const playback = yield* Playback;
        return yield* playback.getInfo("movie-1");
      }),
    );

    expect(info.playSessionId).toBe("play-session");
    expect(info.mediaSources).toHaveLength(3);
    const selected = info.mediaSources.find((entry: any) => entry.Id === "version-a-1") as any;
    expect(selected).toMatchObject({
      Path: "/Videos/movie-1/stream?MediaSourceId=version-a-1",
      DirectStreamUrl: "/Videos/movie-1/stream?MediaSourceId=version-a-1",
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      MediaStreams: [{ Index: 7 }, { Index: 11 }],
    });
    expect(selected).not.toHaveProperty("TranscodingUrl");
    expect(JSON.stringify(info)).not.toContain("api_key");
  });

  it("resolves only registered external text subtitles by version and stream index", async () => {
    const sourceA = source("a", "source-a", "item-a");
    const fixture = makeFixture({
      sources: [sourceA],
      eligible: [eligible("a", 0)],
      versions: [
        version("version-a", sourceA.id, "media-a", [
          {
            Index: 2,
            Type: "Subtitle",
            Codec: "srt",
            IsExternal: true,
            IsTextSubtitleStream: true,
          },
          {
            Index: 3,
            Type: "Subtitle",
            Codec: "pgs",
            IsExternal: true,
            IsTextSubtitleStream: false,
          },
          {
            Index: 4,
            Type: "Subtitle",
            Codec: "srt",
            IsExternal: false,
            IsTextSubtitleStream: true,
          },
        ]),
      ],
    });
    const playback = await fixture.run(Playback);

    await expect(
      Effect.runPromise(
        playback.resolveSubtitle({
          canonicalId: "movie-1",
          mediaSourceId: "version-a",
          streamIndex: 2,
          format: "srt",
        }),
      ),
    ).resolves.toMatchObject({
      _tag: "Proxy",
      request: {
        key: "subtitle:movie-1:version-a:2:srt:1",
        kind: "subtitle",
        maxBytes: 5 * 1024 * 1024,
      },
    });
    await expect(
      Effect.runPromise(
        playback.resolveSubtitle({
          canonicalId: "movie-1",
          mediaSourceId: "version-a",
          streamIndex: 3,
          format: "pgs",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ResourceRejected" });
    await expect(
      Effect.runPromise(
        playback.resolveSubtitle({
          canonicalId: "movie-1",
          mediaSourceId: "version-a",
          streamIndex: 4,
          format: "srt",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ResourceRejected" });
  });

  it("builds registered image requests from canonical source identity", async () => {
    const fixture = makeFixture();
    const playback = await fixture.run(Playback);
    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        imageIndex: 0,
      }),
    );

    expect(decision).toMatchObject({
      _tag: "Proxy",
      request: {
        key: "image:movie-1:Primary:0:version-a-1:1",
        kind: "image",
        maxBytes: 20 * 1024 * 1024,
      },
    });
    expect(decision._tag === "Proxy" && decision.request.url.href).toBe(
      "https://a.example.com/Items/item-a/Images/Primary/0?api_key=token-a",
    );
  });

  it.each(["Infuse-Direct/8.5.6", " infuse-library/8.5.6 "])(
    "serves cached CDN artwork as image bytes for %s",
    async (clientUserAgent) => {
      const requests: Request[] = [];
      const fixture = makeFixture({
        externalImage: new URL("https://image.tmdb.org/t/p/w780/poster.jpg"),
        fetchArtwork: (async (request: Request) => {
          requests.push(request);
          return new Response("poster", { headers: { "content-type": "image/jpeg" } });
        }) as typeof fetch,
      });
      const playback = await fixture.run(Playback);
      const decision = await Effect.runPromise(
        playback.resolveImage({
          canonicalId: "movie-1",
          imageType: "Primary",
          clientUserAgent,
        }),
      );
      expect(decision._tag).toBe("Proxy");
      if (decision._tag !== "Proxy") throw new Error("expected local image delivery");
      const response = await Effect.runPromise(serveRegisteredResource(decision.request, {}));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(await response.text()).toBe("poster");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("https://image.tmdb.org/t/p/w780/poster.jpg");
      expect(requests[0]!.redirect).toBe("manual");
      expect(requests[0]!.headers.has("authorization")).toBe(false);
      expect(requests[0]!.headers.has("x-emby-token")).toBe(false);
    },
  );

  it.each([true, false])(
    "serves upstream CDN artwork locally for Infuse (versions: %s)",
    async (hasVersions) => {
      const fixture = makeFixture({
        ...(hasVersions ? {} : { versions: [] }),
        clientUsable: true,
        fetchArtwork: (async () =>
          new Response("episode", {
            headers: { "content-type": "image/jpeg" },
          })) as typeof fetch,
      });
      const playback = await fixture.run(Playback);
      const decision = await Effect.runPromise(
        playback.resolveImage({
          canonicalId: "movie-1",
          imageType: "Primary",
          clientUserAgent: "Infuse-Direct/8.5.6",
        }),
      );
      expect(decision._tag).toBe("Proxy");
      if (decision._tag !== "Proxy") throw new Error("expected local image delivery");
      const response = await Effect.runPromise(serveRegisteredResource(decision.request, {}));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("episode");
    },
  );

  it("serves a registered upstream image that has no CDN redirect for Infuse", async () => {
    const fixture = makeFixture({
      clientUsable: true,
      imageRedirect: new URL("https://a.example.com/Items/item-a/Images/Primary?api_key=token-a"),
      fetchArtwork: (async (request: Request) => {
        expect(request.url).toBe(
          "https://a.example.com/Items/item-a/Images/Primary?api_key=token-a",
        );
        expect(request.headers.get("user-agent")).toBe("test");
        expect(request.headers.has("authorization")).toBe(false);
        return new Response("upstream-image", { headers: { "content-type": "image/jpeg" } });
      }) as typeof fetch,
    });
    const playback = await fixture.run(Playback);
    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        clientUserAgent: "Infuse-Direct/8.5.6",
      }),
    );
    expect(decision._tag).toBe("Proxy");
    if (decision._tag !== "Proxy") throw new Error("expected local image delivery");
    const response = await Effect.runPromise(serveRegisteredResource(decision.request, {}));
    expect(await response.text()).toBe("upstream-image");
  });

  it.each(["http://127.0.0.1/private", "https://image.tmdb.org.evil.example/poster.jpg"])(
    "rejects an untrusted artwork destination %s before fetching",
    async (url) => {
      let fetched = false;
      const fixture = makeFixture({
        externalImage: new URL(url),
        fetchArtwork: (async () => {
          fetched = true;
          return new Response();
        }) as typeof fetch,
      });
      const playback = await fixture.run(Playback);
      await expect(
        Effect.runPromise(
          playback.resolveImage({
            canonicalId: "movie-1",
            imageType: "Primary",
            clientUserAgent: "Infuse-Direct/8.5.6",
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ResourceRejected" });
      expect(fetched).toBe(false);
    },
  );

  it("aborts a pending Infuse artwork fetch at the delivery deadline", async () => {
    let aborted = false;
    const fixture = makeFixture({
      externalImage: new URL("https://image.tmdb.org/t/p/w780/poster.jpg"),
      fetchArtwork: ((request: Request) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                new Response("poster", {
                  headers: { "content-type": "image/jpeg" },
                }),
              ),
            100,
          );
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        })) as typeof fetch,
    });
    const playback = await fixture.run(Playback);
    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        clientUserAgent: "Infuse-Direct/8.5.6",
      }),
    );
    if (decision._tag !== "Proxy") throw new Error("expected local image delivery");
    await expect(
      Effect.runPromise(serveRegisteredResource(decision.request, { deadlineMs: 10 })),
    ).rejects.toMatchObject({ _tag: "ResourceTimeout" });
    expect(aborted).toBe(true);
  });

  it("serves the verified backup image endpoint returned by redirect resolution", async () => {
    const upstreamSource = eligible("a", 0);
    const backup = {
      ...upstreamSource.endpoints[0]!,
      id: "backup",
      host: "backup.example.com",
      path: "/emby",
      displayUrl: "https://backup.example.com/emby",
      order: 1,
    };
    const fixture = makeFixture({
      sources: [source("a", "source-a", "item-a")],
      eligible: [{ ...upstreamSource, endpoints: [...upstreamSource.endpoints, backup] }],
      clientUsable: true,
      imageRedirect: new URL(
        "https://backup.example.com/emby/Items/item-a/Images/Primary?api_key=token-a",
      ),
      fetchArtwork: (async () =>
        new Response("backup-image", {
          headers: { "content-type": "image/jpeg" },
        })) as typeof fetch,
    });
    const playback = await fixture.run(Playback);
    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        clientUserAgent: "Infuse-Direct/8.5.6",
      }),
    );
    if (decision._tag !== "Proxy") throw new Error("expected local image delivery");
    const response = await Effect.runPromise(serveRegisteredResource(decision.request, {}));
    expect(await response.text()).toBe("backup-image");
  });

  it("does not reuse cached registered artwork after the server generation changes", async () => {
    const sourceItem = source("a", "source-a", "item-a");
    const media = version("version-a", sourceItem.id, "media-a");
    const upstreamSource = eligible("a", 0);
    const fixture = makeFixture({
      sources: [sourceItem],
      versions: [media],
      eligible: [upstreamSource],
      clientUsable: true,
      imageRedirect: new URL("https://a.example.com/Items/item-a/Images/Primary?api_key=token-a"),
      fetchArtwork: (async () =>
        new Response(`generation-${upstreamSource.serverGeneration}`, {
          headers: { "content-type": "image/jpeg" },
        })) as typeof fetch,
    });
    const values = new Map<string, CachedResource>();
    const cache = {
      get: (key: string) => Effect.succeed(values.get(key) ?? null),
      put: (key: string, response: CountedResource, expiresAtMs: number) =>
        Effect.sync(() => {
          values.set(key, { ...response, expiresAtMs });
        }),
      prune: () => Effect.void,
    };
    const playback = await fixture.run(Playback);
    const read = async () => {
      const decision = await Effect.runPromise(
        playback.resolveImage({
          canonicalId: "movie-1",
          imageType: "Primary",
          clientUserAgent: "Infuse-Direct/8.5.6",
        }),
      );
      if (decision._tag !== "Proxy") throw new Error("expected local image delivery");
      return (await Effect.runPromise(serveRegisteredResource(decision.request, { cache }))).text();
    };
    expect(await read()).toBe("generation-1");
    Object.assign(sourceItem, { serverGeneration: 2 });
    Object.assign(media, { serverGeneration: 2 });
    Object.assign(upstreamSource, { serverGeneration: 2 });
    expect(await read()).toBe("generation-2");
  });

  it("redirects validated cached external artwork before trying upstream images", async () => {
    const fixture = makeFixture({
      externalImage: new URL("https://image.tmdb.org/t/p/w780/poster.jpg"),
    });
    const playback = await fixture.run(Playback);

    await expect(
      Effect.runPromise(
        playback.resolveImage({
          canonicalId: "movie-1",
          imageType: "Primary",
        }),
      ),
    ).resolves.toEqual({
      _tag: "Redirect",
      location: new URL("https://image.tmdb.org/t/p/w780/poster.jpg"),
    });
    expect(fixture.resolutions).toEqual([]);
    expect(fixture.metadataRefreshes).toBe(0);
  });

  it.each(["Primary", "Backdrop", "Logo"])(
    "fills cold external metadata for the first %s image request",
    async (imageType) => {
      const expected = new URL("https://image.tmdb.org/t/p/w780/poster.jpg");
      const fixture = makeFixture({ imageAfterRefresh: expected });
      const playback = await fixture.run(Playback);
      await expect(
        Effect.runPromise(playback.resolveImage({ canonicalId: "movie-1", imageType })),
      ).resolves.toEqual({ _tag: "Redirect", location: expected });
      expect(fixture.metadataRefreshes).toBe(1);
      await Effect.runPromise(playback.resolveImage({ canonicalId: "movie-1", imageType }));
      expect(fixture.metadataRefreshes).toBe(1);
    },
  );

  it.each([
    ["Thumb", 0],
    ["Primary", 1],
  ] as const)("does not fetch external artwork for %s index %s", async (imageType, imageIndex) => {
    const fixture = makeFixture();
    const playback = await fixture.run(Playback);
    await Effect.runPromise(
      playback.resolveImage({ canonicalId: "movie-1", imageType, imageIndex }),
    );
    expect(fixture.metadataRefreshes).toBe(0);
  });

  it("keeps the upstream image fallback when a provider has no artwork", async () => {
    const fixture = makeFixture();
    const playback = await fixture.run(Playback);
    const decision = await Effect.runPromise(
      playback.resolveImage({ canonicalId: "movie-1", imageType: "Primary" }),
    );
    expect(decision._tag).toBe("Proxy");
    expect(fixture.metadataRefreshes).toBe(1);
  });

  it("builds image requests from a source item when media versions are absent", async () => {
    const fixture = makeFixture({ versions: [] });
    const playback = await fixture.run(Playback);

    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
      }),
    );

    expect(decision).toMatchObject({
      _tag: "Proxy",
      request: { key: "image:movie-1:Primary:default:source-a:1" },
    });
    expect(decision._tag === "Proxy" && decision.request.url.href).toBe(
      "https://a.example.com/Items/item-a/Images/Primary?api_key=token-a",
    );
  });

  it("resolves source-item artwork to the CDN before redirecting the client", async () => {
    const fixture = makeFixture({ versions: [], clientUsable: true });
    const playback = await fixture.run(Playback);

    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        clientUserAgent: "Rex-Standard/0.5.0",
      }),
    );
    expect(decision._tag).toBe("Redirect");
    expect(decision._tag === "Redirect" && decision.location.href).toBe(
      "https://image.tmdb.org/t/p/w780/episode.jpg",
    );
    expect(fixture.clientUserAgents).toEqual(["Rex-Standard/0.5.0"]);
  });

  it("distinguishes omitted and zero image indexes and includes registration generation in cache keys", async () => {
    const sourceA = source("a", "source-a", "item-a", 2);
    const fixture = makeFixture({
      sources: [sourceA],
      eligible: [{ ...eligible("a", 0), serverGeneration: 2 }],
      versions: [{ ...version("version-a", sourceA.id, "media-a"), serverGeneration: 2 }],
    });
    const playback = await fixture.run(Playback);
    const omitted = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
      }),
    );
    const zero = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        imageIndex: 0,
      }),
    );

    expect(omitted._tag === "Proxy" && omitted.request.key).toBe(
      "image:movie-1:Primary:default:version-a:2",
    );
    expect(zero._tag === "Proxy" && zero.request.key).toBe("image:movie-1:Primary:0:version-a:2");
  });

  it("opens auxiliary resources through the request-time destination boundary", async () => {
    let boundaryCalls = 0;
    const fixture = makeFixture({
      resourceRequest: () => {
        boundaryCalls++;
        return Effect.fail({ _tag: "DestinationRejected", serverId: "a" });
      },
    });
    const playback = await fixture.run(Playback);
    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
      }),
    );
    if (decision._tag !== "Proxy") throw new Error("expected proxy");

    await expect(
      Effect.runPromise(serveRegisteredResource(decision.request, {})),
    ).rejects.toMatchObject({
      _tag: "ResourceUnavailable",
    });
    expect(boundaryCalls).toBe(1);
  });

  it("resolves media-version artwork to the CDN before redirecting the client", async () => {
    const fixture = makeFixture({ clientUsable: true });
    const playback = await fixture.run(Playback);

    const decision = await Effect.runPromise(
      playback.resolveImage({
        canonicalId: "movie-1",
        imageType: "Primary",
        clientUserAgent: "Rex-Standard/0.5.0",
      }),
    );
    expect(decision._tag).toBe("Redirect");
    expect(decision._tag === "Redirect" && decision.location.href).toBe(
      "https://image.tmdb.org/t/p/w780/episode.jpg",
    );
    expect(fixture.clientUserAgents).toEqual(["Rex-Standard/0.5.0"]);
  });
});
