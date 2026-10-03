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
          Effect.succeed({ id: "20", Name: "Set", movieIds: ["10", "11", "12"] }),
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
        Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(deps, collections)))),
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
  it("does not scan an empty movie catalog to invent TMDB collections", async () => {
    let requests = 0;
    const test = await setup(() => {
      requests++;
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
    expect(requests).toBe(0);
  });
});
