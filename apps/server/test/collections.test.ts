import { Database } from "bun:sqlite";
import { makeCollectionRepositories } from "../src/core/collection-repositories.js";
import { RepositoryError } from "../src/core/errors.js";
import { ClientLanguage } from "../src/core/client-language.js";
import { Playback, makePlaybackLayer, serveRegisteredResource } from "../src/core/playback.js";
import { Federation, makeFederationLayer } from "../src/core/federation.js";
import { UpstreamNotFound, UpstreamTimeout } from "../src/core/errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
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
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const setup = async (
    handle: (serverId: string, path: string) => Effect.Effect<unknown, any>,
    collectionReader?: (id: string) => Effect.Effect<any, any>,
    failServerLookup = false,
  ) => {
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
        readTmdbCollection:
          collectionReader ??
          (() =>
            Effect.succeed({
              id: "20",
              Name: "A Set",
              ExternalImages: { Primary: "https://image.tmdb.org/t/p/w780/set.jpg" },
              movieIds: ["10", "11", "12"],
            })),
        refresh: (r: any) => Effect.succeed(r),
        overlayCached: (r: any) => Effect.succeed(r),
      } as any),
    );
    const activeRepositories = failServerLookup
      ? Layer.effect(
          Repositories,
          Effect.map(Repositories, (r) =>
            Repositories.of({
              ...r,
              getServer: () =>
                Effect.fail(new RepositoryError({ operation: "getServer", message: "injected" })),
            }),
          ),
        ).pipe(Layer.provide(repositories))
      : repositories;
    const deps = Layer.mergeAll(
      activeRepositories,
      makeIdentityLayer.pipe(Layer.provide(activeRepositories)),
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
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 900001);
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
        const coldZero = yield* federation.list({
          ...query,
          limit: 0,
          sort: [{ field: "SortName", direction: "Ascending" }],
        });
        const favoriteQuery = {
          ...query,
          filters: [{ field: "favorite", value: true }],
          limit: 30,
        } as const;
        const beforeFavorite = yield* federation.list(favoriteQuery);
        yield* (yield* Repositories).writeUserStateAndTargets({
          canonicalId: second.items[0]!.id,
          patch: { favorite: true },
          updatedAtMs: Date.now(),
        });
        yield* federation.invalidateStateDependentGenerations();
        const afterFavorite = yield* federation.list(favoriteQuery);
        return { first, second, boxes, zero, coldZero, beforeFavorite, afterFavorite };
      }),
    );
    expect(result.beforeFavorite.totalRecordCount).toBe(0);
    expect(result.afterFavorite.totalRecordCount).toBe(1);
    expect(result.coldZero.totalRecordCount).toBe(2);
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
          metadata: {
            Name: "Custom",
            ImageTags: { Primary: "tag" },
            ExternalImages: { Primary: "https://unregistered.example/image?api_key=secret" },
          },
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

  it("resumes interrupted TMDB member discovery and reuses completed results on later pages", async () => {
    const calls: string[] = [];
    let block = true;
    const test = await setup((serverId, path) => {
      const id = new URL(path, "https://test").searchParams.get("AnyProviderIdEquals");
      if (id) {
        calls.push(`${serverId}:${id}`);
        if (id === "tmdb.11" && block) {
          block = false;
          return Effect.never;
        }
      }
      return Effect.succeed({ Items: [], TotalRecordCount: 0 });
    });
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
        const collections = yield* Collections;
        const query = {
          scope: { virtualLibraryId: null },
          startIndex: 0,
          limit: 1,
          sort: [],
        } as const;
        yield* collections.members(set.id, query).pipe(Effect.timeout(30), Effect.result);
        const complete = yield* collections.members(set.id, query);
        const count = calls.length;
        yield* collections.members(set.id, { ...query, startIndex: 1 });
        return { complete, count, final: calls.length };
      }),
    );
    expect(calls.filter((c) => c === "server-0:tmdb.10")).toHaveLength(1);
    expect(result.complete?.exhausted).toBe(true);
    expect(result.final).toBe(result.count);
  });

  it("isolates collection query ordering by client language", async () => {
    const test = await setup(
      () => Effect.succeed({ Items: [], TotalRecordCount: 0 }),
      (id) =>
        Effect.map(ClientLanguage, (lang) => ({
          id,
          Name: lang === "zh-CN" ? (id === "20" ? "Z" : "A") : id === "20" ? "A" : "Z",
          movieIds: [],
        })),
    );
    const result = await test.run(
      Effect.gen(function* () {
        const repo = yield* Repositories,
          identity = yield* Identity;
        for (const id of ["20", "30"]) {
          const movie = yield* identity.resolve({
            serverId: "server-0",
            catalogNamespace: "catalog:0",
            verifiedCatalogId: "catalog-id:0",
            serverGeneration: 1,
            sourceLibraryId: "movies-0",
            upstreamItemId: `film-${id}`,
            itemType: "Movie",
            providerIds: { tmdbMovie: id },
            displayMetadata: { Name: "Film" },
          });
          yield* repo.upsertCollection({ tmdbCollectionId: id, metadata: {}, observedAtMs: 1000 });
          yield* repo.replaceTmdbCollectionMembership({
            sourceItemId: movie.sourceItem.id,
            tmdbCollectionId: id,
            expectedGeneration: 1,
            observedAtMs: 1000,
          });
        }
        const federation = yield* Federation;
        const query = {
          virtualLibraryId: null,
          itemTypes: ["BoxSet"],
          startIndex: 0,
          limit: 30,
          sort: [{ field: "SortName", direction: "Ascending" }],
          filters: [],
          userId: "u",
          deviceId: "d",
        } as const;
        const en = yield* federation
          .list(query)
          .pipe(Effect.provideService(ClientLanguage, "en-US"));
        const zh = yield* federation
          .list(query)
          .pipe(Effect.provideService(ClientLanguage, "zh-CN"));
        return { en, zh };
      }),
    );
    expect(result.en.items.map((i) => i.id)).toEqual(["collection:tmdb:20", "collection:tmdb:30"]);
    expect(result.zh.items.map((i) => i.id)).toEqual(["collection:tmdb:30", "collection:tmdb:20"]);
  });

  it("propagates repository failures instead of returning partial collection success", async () => {
    const test = await setup(
      () => Effect.succeed({ Items: [], TotalRecordCount: 0 }),
      undefined,
      true,
    );
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
        return yield* (yield* Collections)
          .members(set.id, {
            scope: { virtualLibraryId: null },
            startIndex: 0,
            limit: 30,
            sort: [],
          })
          .pipe(Effect.result);
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("RepositoryError");
  });

  it("atomically fences competing TMDB identities for the same custom BoxSet", async () => {
    await setup(() => Effect.succeed({ Items: [], TotalRecordCount: 0 }));
    const db = new Database(join(directory, "db.sqlite"));
    let armed = false,
      reads = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const repo = makeCollectionRepositories({
      unsafe: (statement, params = []) =>
        Effect.tryPromise(async () => {
          const rows = db.query(statement).all(...(params as any[]));
          if (armed && statement.startsWith("SELECT cs.collection_id")) {
            reads++;
            if (reads === 2) release();
            await barrier;
          }
          return rows as any;
        }),
      batch: (commands) =>
        Effect.sync(() =>
          db.transaction(() => {
            for (const c of commands) db.query(c.statement).run(...(c.params as any[]));
          })(),
        ),
    });
    const source = {
      serverId: "server-0",
      catalogNamespace: "catalog:0",
      serverGeneration: 1,
      upstreamBoxSetId: "race",
    };
    try {
      const custom = await Effect.runPromise(
        repo.upsertCollection({
          tmdbCollectionId: null,
          source,
          metadata: { Name: "Custom" },
          observedAtMs: 1000,
        }),
      );
      armed = true;
      await Promise.all(
        ["20", "30"].map((tmdbCollectionId) =>
          Effect.runPromise(
            repo.upsertCollection({
              tmdbCollectionId,
              source,
              metadata: { Name: "Linked" },
              observedAtMs: 2000,
            }),
          ),
        ),
      );
      const active = db
        .query<{ collection_id: string }, []>("SELECT collection_id FROM collection_sources")
        .get()!.collection_id;
      const alias = db
        .query<{ collection_id: string }, [string]>(
          "SELECT collection_id FROM collection_aliases WHERE alias_id=?",
        )
        .get(custom!.id)!;
      expect(alias.collection_id).toBe(active);
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) as count FROM movie_collections WHERE tmdb_collection_id IS NOT NULL",
          )
          .get()!.count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("continues BoxSet proof after interruption without losing already proven members", async () => {
    const calls: string[] = [];
    let blocked = true;
    const test = await setup((_server, path) => {
      const u = new URL(path, "https://test"),
        parent = u.searchParams.get("ParentId"),
        id = u.searchParams.get("Ids");
      calls.push(`${parent}:${id}`);
      if (parent === "box")
        return Effect.succeed({
          Items: [
            { Id: "one", Type: "Movie", Name: "One" },
            { Id: "two", Type: "Movie", Name: "Two" },
          ],
          TotalRecordCount: 2,
        });
      if (id === "two" && blocked) {
        blocked = false;
        return Effect.never;
      }
      return Effect.succeed({
        Items: id ? [{ Id: id, Type: "Movie", Name: id }] : [],
        TotalRecordCount: id ? 1 : 0,
      });
    });
    const output = await test.run(
      Effect.gen(function* () {
        const repo = yield* Repositories,
          identity = yield* Identity;
        const movie = yield* identity.resolve({
          serverId: "server-0",
          catalogNamespace: "catalog:0",
          verifiedCatalogId: "catalog-id:0",
          serverGeneration: 1,
          sourceLibraryId: "movies-0",
          upstreamItemId: "seed",
          itemType: "Movie",
          providerIds: {},
          displayMetadata: { Name: "Seed" },
        });
        const source = {
          serverId: "server-0",
          catalogNamespace: "catalog:0",
          serverGeneration: 1,
          upstreamBoxSetId: "box",
        };
        const set = (yield* repo.upsertCollection({
          tmdbCollectionId: null,
          source,
          metadata: { Name: "Custom" },
          observedAtMs: 1000,
        }))!;
        yield* repo.writeCollectionSnapshot({
          collectionId: set.id,
          source,
          members: [{ canonicalId: movie.canonical.id, sourceItemId: movie.sourceItem.id }],
          complete: false,
          observedAtMs: 1000,
        });
        const collections = yield* Collections;
        const q = {
          scope: { virtualLibraryId: null },
          startIndex: 0,
          limit: 30,
          sort: [],
        } as const;
        yield* collections.members(set.id, q).pipe(Effect.timeout(30), Effect.result);
        const partial = yield* repo.readCollectionMovies(set.id, q.scope);
        const complete = yield* collections.members(set.id, q);
        const n = calls.length;
        yield* collections.members(set.id, q);
        return { partial, complete, n, final: calls.length };
      }),
    );
    expect(output.partial).toHaveLength(2);
    expect(output.complete?.totalRecordCount).toBe(2);
    expect(calls.filter((c) => c === "box:null")).toHaveLength(1);
    expect(output.final).toBe(output.n);
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
