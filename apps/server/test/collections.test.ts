import { Playback, makePlaybackLayer, serveRegisteredResource } from "../src/core/playback.js";
import { Federation, makeFederationLayer } from "../src/core/federation.js";
import { UpstreamNotFound, UpstreamTimeout } from "../src/core/errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { Collections, makeCollectionsLayer } from "../src/core/collections.js";
import { Identity, makeIdentityLayer } from "../src/core/identity.js";
import { Repositories } from "../src/core/repositories.js";
import { MetadataProviders } from "../src/core/metadata-providers.js";
import { UpstreamClient } from "../src/core/upstream-client.js";
import type { UpstreamServer } from "../src/core/model.js";
import {
  applySqliteMigrations,
  makeSqliteRepositoriesLayer,
} from "../src/platform/bun/sqlite-repositories.js";
const server = (index: number): UpstreamServer => ({
  id: `server-${index}` as any,
  catalogNamespace: `catalog:${index}`,
  verifiedCatalogId: `catalog-id:${index}`,
  verifiedBaseUrl: `https://server-${index}.example.com`,
  generation: 1,
  name: `Server ${index}`,
  endpoints: [
    {
      id: `endpoint-${index}`,
      protocol: "https",
      host: `server-${index}.example.com`,
      port: null,
      path: "",
      displayUrl: `https://server-${index}.example.com` as any,
      verifiedCatalogId: `catalog-id:${index}`,
      health: "healthy",
      lastSuccessAtMs: 1_000,
      order: 0,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    },
  ],
  baseUrl: `https://server-${index}.example.com` as any,
  username: "upstream-user",
  password: "upstream-password",
  accessToken: "token",
  accessTokenExpiresAtMs: null,
  upstreamUserId: `user-${index}`,
  userAgentPolicy: "fixed",
  userAgent: "oh-my-emby-test",
  enabled: true,
  health: "healthy",
  lastSuccessAtMs: 1_000,
  deletedAtMs: null,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
});

describe("Collections", () => {
  let directory: string;
  let repositories: ReturnType<typeof makeSqliteRepositoriesLayer>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "collections-"));
    const filename = join(directory, "db.sqlite");
    await applySqliteMigrations(filename, new URL("../migrations", import.meta.url).pathname);
    repositories = makeSqliteRepositoriesLayer({ filename });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const setup = async (handle: (serverId: string, path: string) => Effect.Effect<unknown, any>) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        const settings = yield* repo.readMetadataSettings();
        yield* repo.writeMetadataSettings(
          settings.map((setting) =>
            setting.id === "tmdb"
              ? { ...setting, enabled: true, credential: "test", updatedAtMs: 1000 }
              : setting,
          ) as any,
        );
        yield* repo.saveServer(server(0));
        yield* repo.saveServer(server(1));
        for (const [id, type] of [
          ["movies", "movies"],
          ["shows", "series"],
        ] as const)
          yield* repo.saveVirtualLibrary(
            {
              id,
              name: id,
              mediaType: type,
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              sources: [0, 1].map((index) => ({
                serverId: `server-${index}`,
                sourceLibraryId: `${id}-${index}`,
                sourceLibraryName: id,
                mediaType: type,
                enabled: true,
                sourceOrder: index,
              })),
            },
            [0, 1].map((index) => ({ serverId: `server-${index}`, generation: 1 })),
          );
      }).pipe(Effect.provide(repositories)),
    );
    const upstream = Layer.succeed(
      UpstreamClient,
      UpstreamClient.of({ request: ({ serverId, path }) => handle(serverId, path) } as any),
    );
    const metadata = Layer.succeed(
      MetadataProviders,
      MetadataProviders.of({
        readTmdbCollection: () =>
          Effect.succeed({
            id: "20",
            Name: "A Set",
            ExternalImages: { Primary: "https://image.tmdb.org/t/p/w780/set.jpg" },
            movieIds: ["10", "11", "12"],
          }),
        refresh: (r: any) => Effect.succeed(r),
        overlayCached: (r: any) => Effect.succeed(r),
      } as any),
    );
    const deps = Layer.mergeAll(
      repositories,
      makeIdentityLayer.pipe(Layer.provide(repositories)),
      upstream,
      metadata,
    );
    const collections = makeCollectionsLayer().pipe(Layer.provide(deps));
    return {
      run: <A>(effect: Effect.Effect<A, any, any>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(
              Layer.mergeAll(
                deps,
                collections,
                makeFederationLayer().pipe(Layer.provide(Layer.merge(deps, collections))),
                makePlaybackLayer({
                  fetchArtwork: async () =>
                    new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
                      headers: { "content-type": "image/jpeg" },
                    }),
                }).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      deps,
                      collections,
                      makeFederationLayer().pipe(Layer.provide(Layer.merge(deps, collections))),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
    };
  };
  it("resolves only accessible TMDB parts and preserves two upstream versions of one movie", async () => {
    const parents: string[] = [];
    const test = await setup((serverId, path) => {
      const url = new URL(path, "https://test");
      parents.push(url.searchParams.get("ParentId") ?? "");
      const id = url.searchParams.get("AnyProviderIdEquals")?.split(".")[1];
      return Effect.succeed({
        Items:
          id === "12"
            ? []
            : [
                {
                  Id: `movie-${id}-${serverId}`,
                  Type: "Movie",
                  Name: `Film ${id}`,
                  ProviderIds: { Tmdb: id },
                  MediaSources: [{ Id: `media-${serverId}`, Container: "mkv" }],
                },
              ],
        TotalRecordCount: id === "12" ? 0 : 1,
      });
    });
    const output = await test.run(
      Effect.gen(function* () {
        const identity = yield* Identity;
        const repo = yield* Repositories;
        const movie = yield* identity.resolve({
          serverId: "server-0",
          catalogNamespace: "catalog:0",
          verifiedCatalogId: "catalog-id:0",
          serverGeneration: 1,
          sourceLibraryId: "movies-0",
          upstreamItemId: "movie-10-server-0",
          itemType: "Movie",
          providerIds: { tmdbMovie: "10" },
          displayMetadata: { Name: "Film 10" },
        });
        const collection = (yield* repo.upsertCollection({
          tmdbCollectionId: "20",
          metadata: { Name: "Set" },
          observedAtMs: 1000,
        }))!;
        yield* repo.replaceTmdbCollectionMembership({
          sourceItemId: movie.sourceItem.id,
          tmdbCollectionId: "20",
          expectedGeneration: 1,
          observedAtMs: 1000,
        });
        const page = (yield* (yield* Collections).members(collection.id, {
          scope: { virtualLibraryId: null },
          startIndex: 0,
          limit: 30,
          sort: [],
        }))!;
        return { page, records: yield* repo.readCatalogItems(page.items) };
      }),
    );
    expect(output.page.items).toHaveLength(2);
    expect(output.page.totalRecordCount).toBe(2);
    expect(
      output.records.find((r) => r.claims.some((c) => c.value === "10"))?.mediaVersions,
    ).toHaveLength(2);
    expect(parents).not.toContain("shows-0");
    expect(parents).not.toContain("shows-1");
  });
  it("discovers upstream BoxSets and excludes movies outside enabled movie libraries", async () => {
    const test = await setup((_serverId, path) => {
      const url = new URL(path, "https://test");
      if (url.searchParams.get("IncludeItemTypes") === "BoxSet")
        return Effect.succeed({
          Items: [
            {
              Id: "box",
              Type: "BoxSet",
              Name: "Custom",
              ProviderIds: {},
              ImageTags: { Primary: "tag" },
            },
          ],
          TotalRecordCount: 1,
        });
      if (url.searchParams.get("ParentId") === "box")
        return Effect.succeed({
          Items: [
            { Id: "allowed", Type: "Movie", Name: "Film", ProviderIds: { Tmdb: "10" } },
            { Id: "hidden", Type: "Movie", Name: "Hidden", ProviderIds: { Tmdb: "12" } },
          ],
          TotalRecordCount: 2,
        });
      const id = url.searchParams.get("Ids");
      return Effect.succeed({
        Items:
          id === "allowed"
            ? [
                {
                  Id: "allowed",
                  Type: "Movie",
                  Name: "Film",
                  ProviderIds: { Tmdb: "10" },
                  MediaSources: [{ Id: "media", Container: "mkv" }],
                },
              ]
            : [],
        TotalRecordCount: id === "allowed" ? 1 : 0,
      });
    });
    const output = await test.run(
      Effect.gen(function* () {
        const collections = yield* Collections;
        const page = yield* collections.list({
          scope: { virtualLibraryId: null },
          startIndex: 0,
          limit: 30,
          sort: [],
        });
        const refs = yield* (yield* Repositories).readCollectionMovies(page.items[0]!.id, {
          virtualLibraryId: null,
        });
        const movies = yield* (yield* Repositories).readCatalogItems(
          refs.map((r) => r.canonicalId),
        );
        return { page, movies };
      }),
    );
    expect(output.page.items).toHaveLength(2); // Same name, no proven collection identity: one per server.
    expect(output.page.items[0]?.childCount).toBe(1);
    expect(output.movies[0]?.canonical.displayMetadata).toMatchObject({ Name: "Film" });
  });

  it("merges proven upstream collection IDs and preserves confirmed members after a partial refresh", async () => {
    let partial = false;
    const test = await setup((_serverId, path) => {
      const url = new URL(path, "https://test");
      if (url.searchParams.get("IncludeItemTypes") === "BoxSet")
        return Effect.succeed({
          Items: [{ Id: "box", Type: "BoxSet", Name: "Set", ProviderIds: { Tmdb: "20" } }],
          TotalRecordCount: 1,
        });
      if (url.searchParams.get("ParentId") === "box") {
        if (partial && Number(url.searchParams.get("StartIndex")) > 0)
          return Effect.fail(new UpstreamTimeout({ serverId: _serverId }));
        return Effect.succeed({
          Items: [{ Id: "allowed", Type: "Movie", Name: "Film", ProviderIds: { Tmdb: "10" } }],
          TotalRecordCount: partial ? 2 : 1,
        });
      }
      if (url.searchParams.get("Ids") === "allowed")
        return Effect.succeed({
          Items: [{ Id: "allowed", Type: "Movie", Name: "Film", ProviderIds: { Tmdb: "10" } }],
          TotalRecordCount: 1,
        });
      return Effect.succeed({ Items: [], TotalRecordCount: 0 });
    });
    const query = {
      scope: { virtualLibraryId: null },
      startIndex: 0,
      limit: 30,
      sort: [],
    } as const;
    const result = await test.run(
      Effect.gen(function* () {
        const collections = yield* Collections;
        const first = yield* collections.list(query);
        partial = true;
        const members = yield* collections.members(first.items[0]!.id, query);
        return { first, members };
      }),
    );
    expect(result.first.items).toHaveLength(1);
    expect(result.members?.items).toHaveLength(1);
    expect(result.members?.exhausted).toBe(false);
    expect(result.members?.incompleteSourceIds).toContain("server-0");
  });

  it("discovers BoxSets through user Views when server-wide item listing is unavailable", async () => {
    const test = await setup((serverId, path) => {
      const url = new URL(path, "https://test");
      if (url.pathname.endsWith("/Views"))
        return Effect.succeed({
          Items: [{ Id: "sets-root", Type: "CollectionFolder", CollectionType: "boxsets" }],
          TotalRecordCount: 1,
        });
      if (url.searchParams.get("IncludeItemTypes") === "BoxSet")
        return url.searchParams.get("ParentId") === "sets-root"
          ? Effect.succeed({
              Items: [{ Id: "box", Type: "BoxSet", Name: "Set", ProviderIds: {} }],
              TotalRecordCount: 1,
            })
          : Effect.fail(new UpstreamNotFound({ serverId }));
      return Effect.succeed({
        Items: [{ Id: "allowed", Type: "Movie", Name: "Film", ProviderIds: { Tmdb: "10" } }],
        TotalRecordCount: 1,
      });
    });
    const page = await test.run(
      Effect.gen(function* () {
        return yield* (yield* Collections).list({
          scope: { virtualLibraryId: null },
          startIndex: 0,
          limit: 30,
          sort: [],
        });
      }),
    );
    expect(page.items).toHaveLength(2);
  });

  it("paginates BoxSets and movies as one sorted federated result", async () => {
    const test = await setup((_serverId, path) => {
      const url = new URL(path, "https://test");
      if (url.searchParams.get("IncludeItemTypes") === "BoxSet")
        return Effect.succeed({
          Items: [{ Id: "box", Type: "BoxSet", Name: "A Set", ProviderIds: { Tmdb: "20" } }],
          TotalRecordCount: 1,
        });
      return Effect.succeed({
        Items: [
          {
            Id: "film",
            Type: "Movie",
            Name: "B Film",
            ProviderIds: { Tmdb: "10" },
            MediaSources: [{ Id: "media", Container: "mkv" }],
          },
        ],
        TotalRecordCount: 1,
      });
    });
    const query = {
      userId: "owner",
      deviceId: "device",
      virtualLibraryId: "movies",
      startIndex: 0,
      limit: 1,
      sort: [{ field: "Name", direction: "Ascending" }],
      filters: [],
      itemTypes: ["Movie", "BoxSet"],
    } as const;
    const result = await test.run(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const first = yield* federation.list(query);
        const second = yield* federation.list({ ...query, startIndex: 1 });
        const boxes = yield* federation.list({ ...query, itemTypes: ["BoxSet"], limit: 30 });
        const zero = yield* federation.list({ ...query, itemTypes: ["BoxSet"], limit: 0 });
        return { first, second, boxes, zero };
      }),
    );
    expect(result.zero.items).toEqual([]);
    expect(result.zero.totalRecordCount).toBe(1);
    expect(result.boxes.items).toHaveLength(1);
    expect(result.first.items[0]?.itemType).toBe("BoxSet");
    expect(result.second.items[0]?.itemType).toBe("Movie");
    expect(result.first.totalRecordCount).toBe(2);
  });

  it("proxies collection artwork for Infuse and rejects collection playback", async () => {
    const test = await setup(() => Effect.succeed({ Items: [], TotalRecordCount: 0 }));
    const result = await test.run(
      Effect.gen(function* () {
        const identity = yield* Identity,
          repo = yield* Repositories;
        const movie = yield* identity.resolve({
          serverId: "server-0",
          catalogNamespace: "catalog:0",
          verifiedCatalogId: "catalog-id:0",
          serverGeneration: 1,
          sourceLibraryId: "movies-0",
          upstreamItemId: "film",
          itemType: "Movie",
          providerIds: { tmdbMovie: "10" },
          displayMetadata: { Name: "Film" },
        });
        const set = (yield* repo.upsertCollection({
          tmdbCollectionId: "20",
          metadata: {},
          observedAtMs: 1000,
        }))!;
        yield* repo.replaceTmdbCollectionMembership({
          sourceItemId: movie.sourceItem.id,
          tmdbCollectionId: "20",
          expectedGeneration: 1,
          observedAtMs: 1000,
        });
        const playback = yield* Playback;
        const image = yield* playback.resolveImage({
          canonicalId: set.id,
          imageType: "Primary",
          clientUserAgent: "Infuse-Direct/8.5.6",
        });
        const regular = yield* playback.resolveImage({
          canonicalId: set.id,
          imageType: "Primary",
          clientUserAgent: "Rex-Standard/0.5.0",
        });
        const playable = yield* playback.getInfo(set.id).pipe(Effect.result);
        const response =
          image._tag === "Proxy" ? yield* serveRegisteredResource(image.request, {}) : null;
        const bytes = response ? yield* Effect.promise(() => response.arrayBuffer()) : null;
        return {
          image,
          regular,
          playable,
          status: response?.status,
          mime: response?.headers.get("content-type"),
          bytes: bytes ? [...new Uint8Array(bytes)] : [],
        };
      }),
    );
    expect(result.status).toBe(200);
    expect(result.mime).toBe("image/jpeg");
    expect(result.bytes).toEqual([0xff, 0xd8, 0xff]);
    expect(result.image._tag).toBe("Proxy");
    expect(result.regular._tag).toBe("Redirect");
    expect(result.playable._tag).toBe("Failure");
  });

  it("uses registered upstream artwork and hides it when the movie scope is disabled", async () => {
    const test = await setup(() => Effect.succeed({ Items: [], TotalRecordCount: 0 }));
    const result = await test.run(
      Effect.gen(function* () {
        const repo = yield* Repositories,
          identity = yield* Identity;
        const movie = yield* identity.resolve({
          serverId: "server-0",
          catalogNamespace: "catalog:0",
          verifiedCatalogId: "catalog-id:0",
          serverGeneration: 1,
          sourceLibraryId: "movies-0",
          upstreamItemId: "film",
          itemType: "Movie",
          providerIds: {},
          displayMetadata: { Name: "Film" },
        });
        const source = {
          serverId: "server-0",
          catalogNamespace: "catalog:0",
          serverGeneration: 1,
          upstreamBoxSetId: "box",
          metadata: { Name: "Custom", ImageTags: { Primary: "tag" } },
        };
        const set = (yield* repo.upsertCollection({
          tmdbCollectionId: null,
          source,
          metadata: source.metadata,
          observedAtMs: 1000,
        }))!;
        yield* repo.writeCollectionSnapshot({
          source,
          collectionId: set.id,
          members: [{ canonicalId: movie.canonical.id, sourceItemId: movie.sourceItem.id }],
          complete: true,
          observedAtMs: 1000,
        });
        const collections = yield* Collections;
        const image = yield* collections.image(set.id, { virtualLibraryId: null }, "Primary");
        const missing = yield* collections.image(set.id, { virtualLibraryId: null }, "Logo");
        const inaccessible = yield* collections.image(
          set.id,
          { virtualLibraryId: "missing" },
          "Primary",
        );
        return { image, missing, inaccessible };
      }),
    );
    expect(result.image?.url.origin).toBe("https://server-0.example.com");
    expect(result.image?.url.pathname).toBe("/Items/box/Images/Primary");
    expect(result.image?.source?.upstreamBoxSetId).toBe("box");
    expect(result.missing).toBeNull();
    expect(result.inaccessible).toBeNull();
  });

  it("does not scan an empty movie catalog to invent TMDB collections", async () => {
    const requestTypes: string[] = [];
    const test = await setup((_id, path) => {
      requestTypes.push(new URL(path, "https://test").searchParams.get("IncludeItemTypes") ?? "");
      return Effect.succeed({ Items: [], TotalRecordCount: 0 });
    });
    const page = await test.run(
      Effect.gen(function* () {
        return yield* (yield* Collections).list({
          scope: { virtualLibraryId: null },
          startIndex: 0,
          limit: 30,
          sort: [],
        });
      }),
    );
    expect(page.items).toEqual([]);
    expect(requestTypes).not.toContain("Movie");
  });
});
