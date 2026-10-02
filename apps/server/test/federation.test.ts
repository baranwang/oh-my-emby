import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Federation, makeFederationLayer, type FederatedQuery } from "../src/core/federation.js";
import {
  UpstreamRejected,
  UpstreamNotFound,
  UpstreamUnavailable,
  type UpstreamFailure,
} from "../src/core/errors.js";
import { makeIdentityLayer } from "../src/core/identity.js";
import { MetadataProviders, type MetadataProvidersApi } from "../src/core/metadata-providers.js";
import {
  MAX_FANOUT_CONCURRENCY,
  METADATA_FRESH_MS,
  METADATA_STALE_MS,
} from "../src/core/limits.js";
import type { UpstreamServer } from "../src/core/model.js";
import { Repositories, type CatalogItemRecord } from "../src/core/repositories.js";
import { UpstreamClient } from "../src/core/upstream-client.js";
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js";

const migration = [
  await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text(),
  await Bun.file(new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)).text(),
].join("\n");

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

const item = (id: string, name = id, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Type: "Movie",
  Name: name,
  ProviderIds: { Tmdb: id.replace(/\D/g, "") || id },
  ...extra,
});

const query = (overrides: Partial<FederatedQuery> = {}): FederatedQuery => ({
  userId: "owner",
  deviceId: "device-1",
  virtualLibraryId: "library-1",
  startIndex: 0,
  limit: 20,
  sort: [{ field: "Name", direction: "Ascending" }],
  filters: [],
  itemTypes: [],
  ...overrides,
});

const typedQuery = (
  itemTypes: ReadonlyArray<string>,
  overrides: Partial<FederatedQuery> = {},
): FederatedQuery => ({ ...query(overrides), itemTypes });

type RequestHandler = (
  serverId: string,
  path: string,
  replayPath?: (userId: string) => string,
) => Effect.Effect<unknown, UpstreamFailure>;

describe("Federation", () => {
  let directory: string;
  let filename: string;
  let repositories: ReturnType<typeof makeSqliteRepositoriesLayer>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-federation-"));
    filename = join(directory, "federation.sqlite");
    const database = new Database(filename);
    database.exec(migration);
    database.close();
    repositories = makeSqliteRepositoriesLayer({ filename });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const setup = async (
    sourceCount: number,
    handle: RequestHandler,
    options: {
      readonly now?: () => number;
      readonly listDeadlineMs?: number;
      readonly detailDeadlineMs?: number;
      readonly metadataProviders?: MetadataProvidersApi;
    } = {},
  ) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        for (let index = 0; index < sourceCount; index++) yield* repo.saveServer(server(index));
        yield* repo.saveVirtualLibrary(
          {
            id: "library-1" as any,
            name: "Movies",
            mediaType: "movies",
            enabled: true,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
            sources: Array.from({ length: sourceCount }, (_, index) => ({
              serverId: `server-${index}` as any,
              sourceLibraryId: `movies-${index}` as any,
              sourceLibraryName: `Movies ${index}`,
              mediaType: "movies" as const,
              sourceOrder: index,
              enabled: true,
            })),
          },
          Array.from({ length: sourceCount }, (_, index) => ({
            serverId: `server-${index}`,
            generation: 1,
          })),
        );
      }).pipe(Effect.provide(repositories)),
    );

    const upstream = Layer.succeed(
      UpstreamClient,
      UpstreamClient.of({
        request: ({ serverId, path, replayPath }) => handle(serverId, path, replayPath) as any,
        authenticate: () => Effect.die("unused") as any,
        getServerIdentity: () => Effect.die("unused") as any,
        listSourceLibraries: () => Effect.die("unused") as any,
        resolvePlayback: () => Effect.die("unused") as any,
      }),
    );
    const identity = makeIdentityLayer.pipe(Layer.provide(repositories));
    const metadataProviders = Layer.succeed(
      MetadataProviders,
      MetadataProviders.of(
        options.metadataProviders ?? {
          refresh: (record) => Effect.succeed(record),
          overlayCached: (record) => Effect.succeed(record),
          resolveCachedImage: () => Effect.succeed(null),
        },
      ),
    );
    const dependencies = Layer.mergeAll(repositories, identity, upstream, metadataProviders);
    return makeFederationLayer(options).pipe(Layer.provide(dependencies));
  };

  it("merges enabled libraries without duplicate items across page boundaries", async () => {
    const layer = await setup(3, (serverId) =>
      Effect.succeed({
        Items:
          serverId === "server-0"
            ? [item("10", "Alpha"), item("20", "Shared")]
            : serverId === "server-1"
              ? [item("20", "Shared"), item("30", "Zulu")]
              : [item("40", "Hidden")],
        TotalRecordCount: serverId === "server-2" ? 1 : 2,
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        const library = (yield* repo.listVirtualLibraries())[0]!;
        for (let index = 0; index < 3; index++) {
          yield* repo.saveVirtualLibrary(
            {
              ...library,
              id: `library-${index + 1}` as any,
              enabled: index !== 2,
              sources: [library.sources[index]!],
            },
            [{ serverId: `server-${index}`, generation: 1 }],
          );
        }
      }).pipe(Effect.provide(repositories)),
    );

    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const first = yield* federation.list(query({ virtualLibraryId: null, limit: 2 }));
        const second = yield* federation.list(
          query({ virtualLibraryId: null, startIndex: 2, limit: 2 }),
        );
        return [first, second];
      }).pipe(Effect.provide(layer)),
    );
    expect(pages[0]!.items.map((entry) => (entry.displayMetadata as any).Name)).toEqual([
      "Alpha",
      "Shared",
    ]);
    expect(pages[1]!.items.map((entry) => (entry.displayMetadata as any).Name)).toEqual(["Zulu"]);
    expect(pages[1]!.totalRecordCount).toBe(3);
    expect(new Set(pages.flatMap((page) => page.items.map(({ id }) => id))).size).toBe(3);
  });

  it("orders cross-library resume results by local activity without upstream reads", async () => {
    let calls = 0;
    const layer = await setup(1, () => {
      calls++;
      return Effect.succeed({
        Items: [item("10", "Older"), item("20", "Recent"), item("30", "Finished")],
        TotalRecordCount: 3,
      });
    });
    const discovered = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(query());
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        for (const entry of discovered.items) {
          const name = (entry.displayMetadata as any).Name;
          yield* repo.writeUserStateAndTargets({
            canonicalId: entry.id,
            patch: { positionTicks: 100, played: name === "Finished" },
            updatedAtMs: name === "Recent" ? 3_000 : 2_000,
          });
        }
      }).pipe(Effect.provide(repositories)),
    );
    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(
          query({
            virtualLibraryId: null,
            filters: [{ field: "resume", value: true }],
            sort: [{ field: "DatePlayed", direction: "Descending" }],
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(resumed.items.map((entry) => (entry.displayMetadata as any).Name)).toEqual([
      "Recent",
      "Older",
    ]);
    expect(calls).toBe(1);
  });

  it("keeps global page membership stable when published metadata changes", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({
        Items: [item("10", "Alpha"), item("20", "Beta"), item("30", "Gamma")],
        TotalRecordCount: 3,
      }),
    );
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(query({ virtualLibraryId: null, limit: 2 }));
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        const [record] = yield* repo.readCatalogItems([first.items[0]!.id]);
        yield* repo.mergeCanonicalMetadata(
          record!.canonical.id,
          record!.sourceItems[0]!.id,
          { ...(record!.canonical.displayMetadata as object), Name: "Zulu" },
          3_000,
        );
      }).pipe(Effect.provide(repositories)),
    );
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(
          query({ virtualLibraryId: null, startIndex: 2, limit: 2 }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(second.items.map((entry) => (entry.displayMetadata as any).Name)).toEqual(["Gamma"]);
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(3);
  });

  it("scopes Rex favorites-first lists to the upstream user and refreshes that scope on auth replay", async () => {
    const layer = await setup(1, (_serverId, path, replayPath) => {
      const parameters = new URL(path, "https://local").searchParams;
      expect(parameters.get("UserId")).toBe("user-0");
      expect(parameters.get("SortBy")).toBe("IsFavoriteOrLiked,Random");
      const refreshed = new URL(replayPath!("refreshed-user"), "https://local").searchParams;
      expect(refreshed.get("UserId")).toBe("refreshed-user");
      expect(refreshed.get("ParentId")).toBe("movies-0");
      expect(refreshed.get("SortBy")).toBe("IsFavoriteOrLiked,Random");
      return Effect.succeed({ Items: [item("10")], TotalRecordCount: 1 });
    });
    const page = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(
          query({
            virtualLibraryId: null,
            sort: [
              { field: "IsFavoriteOrLiked", direction: "Descending" },
              { field: "Random", direction: "Descending" },
            ],
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(page.items).toHaveLength(1);
  });

  it("keeps local resume entries visible when no source is currently healthy", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({ Items: [item("10", "Offline")], TotalRecordCount: 1 }),
    );
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(query());
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        yield* repo.writeUserStateAndTargets({
          canonicalId: first.items[0]!.id,
          patch: { positionTicks: 100 },
          updatedAtMs: 2_000,
        });
        yield* repo.saveServer({ ...server(0), health: "unknown" });
      }).pipe(Effect.provide(repositories)),
    );
    const resume = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(
          query({ virtualLibraryId: null, filters: [{ field: "resume", value: true }] }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(resume.items.map(({ id }) => id)).toEqual([first.items[0]!.id]);
  });

  it("discovers and deduplicates studios from eligible sources without exposing upstream IDs", async () => {
    const paths: string[] = [];
    const layer = await setup(2, (serverId, path) => {
      paths.push(path);
      return Effect.succeed({
        Items: [
          { Id: `private-${serverId}`, Type: "Studio", Name: "Warner" },
          {
            Id: `other-${serverId}`,
            Type: "Studio",
            Name: serverId === "server-0" ? "A24" : "Universal",
          },
        ],
        TotalRecordCount: 2,
      });
    });
    const studios = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).studios(query({ virtualLibraryId: null, limit: 10_000 }));
      }).pipe(Effect.provide(layer)),
    );
    expect(studios.items.map((entry) => (entry.displayMetadata as any).Name)).toEqual([
      "A24",
      "Universal",
      "Warner",
    ]);
    expect(studios.totalRecordCount).toBe(3);
    expect(studios.items.map(({ id }) => id)).toEqual([
      "studio:a24",
      "studio:universal",
      "studio:warner",
    ]);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      const url = new URL(path, "https://local");
      expect(url.pathname).toBe("/Studios");
      expect(url.searchParams.get("ParentId")).toMatch(/^movies-[01]$/);
    }
  });

  it("invalidates offline local membership when a server is disabled and enabled", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({ Items: [item("10")], TotalRecordCount: 1 }),
    );
    const run = (filters: FederatedQuery["filters"] = []) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Federation).list(query({ virtualLibraryId: null, filters }));
        }).pipe(Effect.provide(layer)),
      );
    const discovered = await run();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        yield* repo.writeUserStateAndTargets({
          canonicalId: discovered.items[0]!.id,
          patch: { played: true },
          updatedAtMs: 2_000,
        });
        yield* repo.saveServer({ ...server(0), health: "unknown", enabled: false });
      }).pipe(Effect.provide(repositories)),
    );
    expect((await run([{ field: "played", value: true }])).items).toEqual([]);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Repositories).saveServer({ ...server(0), health: "unknown", enabled: true });
      }).pipe(Effect.provide(repositories)),
    );
    expect((await run([{ field: "played", value: true }])).items.map(({ id }) => id)).toEqual([
      discovered.items[0]!.id,
    ]);
  });

  it("invalidates favorites-first sorting after local state changes", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({ Items: [item("10", "Alpha"), item("20", "Beta")], TotalRecordCount: 2 }),
    );
    const run = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Federation).list(
            query({
              virtualLibraryId: null,
              sort: [
                { field: "IsFavoriteOrLiked", direction: "Descending" },
                { field: "Name", direction: "Ascending" },
              ],
            }),
          );
        }).pipe(Effect.provide(layer)),
      );
    const first = await run();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        yield* repo.writeUserStateAndTargets({
          canonicalId: first.items[1]!.id,
          patch: { favorite: true },
          updatedAtMs: 2_000,
        });
        yield* repo.invalidateStateDependentQueryGenerations();
      }).pipe(Effect.provide(repositories)),
    );
    expect((await run()).items.map((entry) => (entry.displayMetadata as any).Name)).toEqual([
      "Beta",
      "Alpha",
    ]);
  });

  it("filters studio names and preserves user scoping on upstream studio requests", async () => {
    const paths: string[] = [];
    const layer = await setup(1, (_serverId, path) => {
      paths.push(path);
      return Effect.succeed(
        path.startsWith("/Studios?")
          ? { Items: [{ Name: "Warner" }], TotalRecordCount: 1 }
          : {
              Items: [
                item("10", "Included", { Studios: [{ Name: "Warner", Id: "upstream-studio" }] }),
                item("20", "Excluded", { Studios: [{ Name: "Other" }] }),
              ],
              TotalRecordCount: 2,
            },
      );
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(
          query({ filters: [{ field: "Studios", value: ["warner"] }] }),
        );
        expect(page.items.map((entry) => (entry.displayMetadata as any).Name)).toEqual([
          "Included",
        ]);
        yield* federation.studios(query());
      }).pipe(Effect.provide(layer)),
    );
    expect(new URL(paths[0]!, "https://local").searchParams.get("Studios")).toBe("warner");
    expect(new URL(paths[0]!, "https://local").searchParams.get("Fields")).toContain("Studios");
    expect(new URL(paths[1]!, "https://local").searchParams.get("UserId")).toBe("user-0");
  });

  it("terminates bounded studio discovery without advertising unreachable pages", async () => {
    let requested = 0;
    const layer = await setup(2, (serverId, path) => {
      const parameters = new URL(path, "https://local").searchParams;
      expect(parameters.get("SortOrder")).toBe("Descending");
      const limit = Number(parameters.get("Limit"));
      requested += limit;
      return Effect.succeed({
        Items: Array.from({ length: limit }, (_, index) => ({
          Name: `${serverId}-${String(10_000 - index).padStart(5, "0")}`,
        })),
        TotalRecordCount: 10_000,
      });
    });
    const page = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).studios(
          query({
            virtualLibraryId: null,
            limit: 10_000,
            sort: [{ field: "SortName", direction: "Descending" }],
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(requested).toBeLessThanOrEqual(2_000);
    expect(page.items).toHaveLength(2_000);
    expect(page.totalRecordCount).toBe(2_000);
    expect(page.exhausted).toBe(true);
    expect(page.incompleteSourceIds).toEqual(["server-0", "server-1"]);
  });

  it("hydrates played history from local state without scanning upstream libraries", async () => {
    let calls = 0;
    const layer = await setup(1, () => {
      calls++;
      return Effect.succeed({ Items: [item("10", "Watched")], TotalRecordCount: 1 });
    });
    const discovered = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(query());
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Repositories).writeUserStateAndTargets({
          canonicalId: discovered.items[0]!.id,
          patch: { played: true },
          updatedAtMs: 2_000,
        });
      }).pipe(Effect.provide(repositories)),
    );
    const history = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(
          query({ virtualLibraryId: null, filters: [{ field: "played", value: true }] }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(history.items.map(({ id }) => id)).toEqual([discovered.items[0]!.id]);
    expect(calls).toBe(1);
  });

  it("uses cache-only overlays for list rows and refreshes external metadata only for detail", async () => {
    let cached = 0;
    let refreshed = 0;
    const overlay = (name: string) => (catalog: CatalogItemRecord) =>
      Effect.sync(() => ({
        ...catalog,
        canonical: {
          ...catalog.canonical,
          displayMetadata: { ...(catalog.canonical.displayMetadata as object), Name: name },
        },
      }));
    const layer = await setup(
      1,
      () =>
        Effect.succeed({
          Items: [item("movie-10", "Upstream", { ProviderIds: { Tmdb: "10", Imdb: "tt10" } })],
          TotalRecordCount: 1,
        }),
      {
        metadataProviders: {
          overlayCached: (catalog) => {
            cached++;
            return overlay("Cached title")(catalog);
          },
          refresh: (catalog) => {
            refreshed++;
            return overlay("Fresh title")(catalog);
          },
          resolveCachedImage: () => Effect.succeed(null),
        },
      },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        expect(page.items[0]?.displayMetadata).toMatchObject({ Name: "Cached title" });
        expect(cached).toBe(1);
        expect(refreshed).toBe(0);

        const detailed = yield* federation.detail(page.items[0]!.id);
        expect(detailed?.displayMetadata).toMatchObject({ Name: "Fresh title" });
        expect(refreshed).toBe(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.each(["library-1", null])(
    "caps ten-source fan-out at four and keeps partial successes for scope %s",
    async (virtualLibraryId) => {
      let active = 0;
      let peak = 0;
      let cancelled = false;
      const layer = await setup(
        10,
        (serverId) => {
          if (serverId === "server-8") return Effect.fail(new UpstreamUnavailable({ serverId }));
          return Effect.callback<unknown, UpstreamFailure>((resume) => {
            active++;
            peak = Math.max(peak, active);
            const timer = setTimeout(
              () => {
                active--;
                resume(Effect.succeed({ Items: [item(`${serverId}-1`)], TotalRecordCount: 1 }));
              },
              serverId === "server-9" ? 100 : 5,
            );
            return Effect.sync(() => {
              clearTimeout(timer);
              active--;
              if (serverId === "server-9") cancelled = true;
            });
          });
        },
        { listDeadlineMs: 25 },
      );

      const page = await Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          return yield* federation.list(query({ virtualLibraryId }));
        }).pipe(Effect.provide(layer)),
      );

      expect(peak).toBe(4);
      expect(cancelled).toBe(true);
      expect(page.items).toHaveLength(8);
      expect(page.incompleteSourceIds).toEqual(["server-8", "server-9"]);
    },
  );

  it("fails a total miss when every source is unavailable", async () => {
    const layer = await setup(2, (serverId) => Effect.fail(new UpstreamUnavailable({ serverId })));
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* Effect.flip(federation.list(query()));
      }).pipe(Effect.provide(layer)),
    );
    expect(error._tag).toBe("FederationUnavailable");
  });

  it("does not use an unrelated cached list to satisfy a failed search", async () => {
    const layer = await setup(1, (serverId, path) =>
      path.includes("SearchTerm=")
        ? Effect.fail(new UpstreamUnavailable({ serverId }))
        : Effect.succeed({ Items: [item("movie-10", "Cached")], TotalRecordCount: 1 }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        yield* federation.list(query());
        const failed = yield* Effect.flip(federation.search({ ...query(), searchTerm: "Needle" }));
        expect(failed._tag).toBe("FederationUnavailable");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("filters plural item types with OR semantics for list and search", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({
        Items: [
          item("movie-10", "Movie"),
          item("series-20", "Series", { Type: "Series" }),
          item("episode-30", "Episode", { Type: "Episode" }),
        ],
        TotalRecordCount: 3,
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const listed = yield* federation.list(
          typedQuery(["Movie", "Series"], { deviceId: "list-types" }),
        );
        const searched = yield* federation.search({
          ...typedQuery(["Movie", "Series"], { deviceId: "search-types" }),
          searchTerm: "needle",
        });

        expect(listed.items.map(({ itemType }) => itemType)).toEqual(["Movie", "Series"]);
        expect(searched.items.map(({ itemType }) => itemType)).toEqual(["Movie", "Series"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("keeps single item types distinct in durable query identity", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({
        Items: [item("movie-10", "Movie"), item("series-20", "Series", { Type: "Series" })],
        TotalRecordCount: 2,
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const movie = yield* federation.list(typedQuery(["Movie"]));
        const series = yield* federation.list(typedQuery(["Series"]));

        expect(movie.items.map(({ itemType }) => itemType)).toEqual(["Movie"]);
        expect(series.items.map(({ itemType }) => itemType)).toEqual(["Series"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("checks canonical and media-version membership without upstream detail enrichment", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({
        Items: [
          item("movie-10", "Movie", {
            MediaSources: [{ Id: "source-a", Name: "Version A" }],
          }),
        ],
        TotalRecordCount: 1,
      }),
    );
    const page = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* federation.list(query());
      }).pipe(Effect.provide(layer)),
    );
    const canonicalId = page.items[0]!.id;
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        return yield* repo.readCatalogItems([canonicalId]);
      }).pipe(Effect.provide(repositories)),
    );
    const versionId = records[0]!.mediaVersions[0]!.id;

    const membership = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return {
          canonical: yield* federation.lookupMembership(canonicalId),
          version: yield* federation.lookupMembership(canonicalId, versionId),
          wrongVersion: yield* federation.lookupMembership(canonicalId, "version-other"),
          missing: yield* federation.lookupMembership("canonical-missing"),
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(membership.canonical?.item.id).toBe(canonicalId);
    expect(membership.version?.version?.id).toBe(versionId);
    expect(membership.wrongVersion).toBeNull();
    expect(membership.missing).toBeNull();
  });

  it("labels detailed media versions with their upstream server", async () => {
    const layer = await setup(1, () =>
      Effect.succeed({
        Items: [
          item("movie-10", "Movie", {
            MediaSources: [{ Id: "source-a", Name: "Version A", Container: "mkv" }],
          }),
        ],
        TotalRecordCount: 1,
      }),
    );

    const detailed = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        return yield* federation.detail(page.items[0]!.id);
      }).pipe(Effect.provide(layer)),
    );

    expect(detailed?.mediaVersions).toMatchObject([
      {
        upstreamMediaSourceId: "source-a",
        label: "[Server 0] Version A",
      },
    ]);
  });

  it("does not expose media versions from a list projection without a fresh detail projection", async () => {
    const now = 1_000;
    const layer = await setup(
      1,
      () =>
        Effect.succeed({
          Items: [
            item("movie-10", "Movie", {
              MediaSources: [{ Id: "source-a", Name: "A" }],
            }),
          ],
          TotalRecordCount: 1,
        }),
      { now: () => now },
    );

    const page = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(query());
      }).pipe(Effect.provide(layer)),
    );

    expect(page.items[0]?.mediaVersions).toEqual([]);
  });

  it("does not replay arbitrary first-page metadata after a deep-page transient failure", async () => {
    const layer = await setup(1, (serverId, path) => {
      const url = new URL(path, "https://local");
      const start = Number(url.searchParams.get("StartIndex"));
      if (!url.searchParams.has("SearchTerm")) {
        return Effect.succeed({
          Items: Array.from({ length: 100 }, (_, index) => item(`aaa-warm-${1_000 + index}`)),
          TotalRecordCount: 100,
        });
      }
      if (start === 0) {
        return Effect.succeed({
          Items: Array.from({ length: 100 }, (_, index) => item(`zzz-target-${2_000 + index}`)),
          TotalRecordCount: 200,
        });
      }
      return Effect.fail(new UpstreamUnavailable({ serverId }));
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        yield* federation.list(query({ limit: 100 }));
        const deep = yield* federation.search({
          ...query({ startIndex: 100, limit: 1 }),
          searchTerm: "Needle",
        });
        expect(deep.items).toEqual([]);
        expect(deep.incompleteSourceIds).toEqual(["server-0"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does not let a lightweight projection erase richer cached metadata", async () => {
    let rich = true;
    const layer = await setup(1, () =>
      Effect.succeed({
        Items: [item("movie-10", "Movie", rich ? { Overview: "Rich overview" } : {})],
        TotalRecordCount: 1,
      }),
    );
    const run = (deviceId: string, fields: ReadonlyArray<string>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          return yield* federation.list(query({ deviceId, fields }));
        }).pipe(Effect.provide(layer)),
      );

    await run("rich", ["Overview"]);
    rich = false;
    await run("light", ["Name"]);
    const replay = await run("replay", ["Overview"]);
    expect(replay.items[0]?.displayMetadata).toMatchObject({
      Name: "Movie",
      Overview: "Rich overview",
    });
  });

  it("updates fields present in a fresh primary projection without erasing omitted fields", async () => {
    let response = item("movie-10", "Old name", { Overview: "Keep me" });
    const layer = await setup(1, () => Effect.succeed({ Items: [response], TotalRecordCount: 1 }));
    const run = (deviceId: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          return yield* federation.list(query({ deviceId }));
        }).pipe(Effect.provide(layer)),
      );

    await run("old");
    response = item("movie-10", "New name");
    const refreshed = await run("new");
    expect(refreshed.items[0]?.displayMetadata).toMatchObject({
      Name: "New name",
      Overview: "Keep me",
    });
  });

  it("keeps client field projections distinct while sharing offset and limit identity", async () => {
    let calls = 0;
    const layer = await setup(1, (_serverId, path) => {
      calls++;
      return Effect.succeed({
        Items: [item("movie-10", "Movie", path.includes("Overview") ? { Overview: "Loaded" } : {})],
        TotalRecordCount: 1,
      });
    });
    const run = (fields: ReadonlyArray<string>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          return yield* federation.list(query({ fields }));
        }).pipe(Effect.provide(layer)),
      );

    await run(["Name"]);
    const detailedProjection = await run(["Overview"]);
    expect(detailedProjection.items[0]?.displayMetadata).toMatchObject({ Overview: "Loaded" });
    expect(calls).toBe(2);
  });

  it("sorts duplicates by the winning source metadata after concurrent identity merge", async () => {
    const layer = await setup(2, (serverId) =>
      serverId === "server-0"
        ? Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              Items: [item("primary-10", "Zulu", { ProviderIds: { Tmdb: "10" } })],
              TotalRecordCount: 1,
            };
          })
        : Effect.succeed({
            Items: [
              item("copy-10", "Alpha", { ProviderIds: { Tmdb: "10" } }),
              item("movie-11", "Beta", { ProviderIds: { Tmdb: "11" } }),
            ],
            TotalRecordCount: 2,
          }),
    );
    const page = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* federation.list(query());
      }).pipe(Effect.provide(layer)),
    );
    expect(
      page.items.map(({ displayMetadata }) =>
        typeof displayMetadata === "object" &&
        displayMetadata !== null &&
        !Array.isArray(displayMetadata)
          ? displayMetadata.Name
          : null,
      ),
    ).toEqual(["Beta", "Zulu"]);
  });

  it("hydrates favorite and resume membership from canonical local state", async () => {
    let calls = 0;
    const layer = await setup(1, () => {
      calls++;
      return Effect.succeed({ Items: [item("movie-10")], TotalRecordCount: 1 });
    });
    const discovered = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* federation.list(query());
      }).pipe(Effect.provide(layer)),
    );
    const canonicalId = discovered.items[0]!.id;
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repositories;
        yield* repo.writeUserStateAndTargets({
          canonicalId,
          patch: {
            played: false,
            favorite: true,
            playCount: 0,
            positionTicks: 123,
            lastPlayedVersionId: null,
          },
          updatedAtMs: 2_000,
        });
        yield* repo.invalidateStateDependentQueryGenerations();
      }).pipe(Effect.provide(repositories)),
    );

    const favorites = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* federation.list(query({ filters: [{ field: "favorite", value: true }] }));
      }).pipe(Effect.provide(layer)),
    );
    const resume = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* federation.list(
          query({
            deviceId: "resume-device",
            filters: [{ field: "resume", value: true }],
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(favorites.items.map(({ id }) => id)).toEqual([canonicalId]);
    expect(resume.items.map(({ id }) => id)).toEqual([canonicalId]);
    expect(calls).toBe(1);
  });

  it("discovers neutral items for negative local-state filters", async () => {
    let calls = 0;
    const layer = await setup(1, () => {
      calls++;
      return Effect.succeed({ Items: [item("movie-10")], TotalRecordCount: 1 });
    });
    const page = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        return yield* federation.list(query({ filters: [{ field: "favorite", value: false }] }));
      }).pipe(Effect.provide(layer)),
    );
    expect(page.items).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it.each(["library-1", null])(
    "caps duplicate and filtered source scans at 2,000 rows for scope %s",
    async (virtualLibraryId) => {
      let scanned = 0;
      const layer = await setup(10, (_serverId, path) => {
        const limit = Number(new URL(path, "https://local").searchParams.get("Limit"));
        const count = Math.min(95, limit);
        scanned += count;
        return Effect.succeed({
          Items: Array.from({ length: count }, (_, index) => ({
            Id: `unsupported-${index}`,
            Type: "BoxSet",
            Name: "Filtered",
          })),
          TotalRecordCount: 10_000,
        });
      });
      if (virtualLibraryId === null) {
        await Effect.runPromise(
          Effect.gen(function* () {
            const repo = yield* Repositories;
            const library = (yield* repo.listVirtualLibraries())[0]!;
            for (let index = 0; index < 2; index++) {
              yield* repo.saveVirtualLibrary(
                {
                  ...library,
                  id: `library-${index + 1}` as any,
                  sources: library.sources.slice(index * 5, index * 5 + 5),
                },
                Array.from({ length: 5 }, (_, offset) => ({
                  serverId: `server-${index * 5 + offset}`,
                  generation: 1,
                })),
              );
            }
          }).pipe(Effect.provide(repositories)),
        );
      }
      const page = await Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          return yield* federation.list(
            query({ virtualLibraryId, filters: [{ field: "favorite", value: false }] }),
          );
        }).pipe(Effect.provide(layer)),
      );
      expect(scanned).toBe(2_000);
      expect(page.items).toEqual([]);
      expect(page.exhausted).toBe(true);
    },
  );

  it("enriches versions with typed provider IDs and never fuzzy search", async () => {
    const paths: Array<string> = [];
    const layer = await setup(2, (serverId, path) => {
      paths.push(path);
      if (serverId === "server-0")
        return Effect.succeed({
          Items: [
            item("movie-10", "Movie", {
              MediaSources: [{ Id: "source-a", Name: "A" }],
            }),
          ],
          TotalRecordCount: 1,
        });
      if (path.includes("AnyProviderIdEquals=tmdb.10"))
        return Effect.succeed({
          Items: [
            item("copy-10", "Movie", {
              ProviderIds: { Tmdb: "10" },
              MediaSources: [{ Id: "source-b", Name: "B" }],
            }),
          ],
          TotalRecordCount: 1,
        });
      return Effect.succeed({ Items: [], TotalRecordCount: 0 });
    });

    const detailed = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        return yield* federation.detail(page.items[0]!.id);
      }).pipe(Effect.provide(layer)),
    );

    expect(detailed?.mediaVersions).toHaveLength(2);
    expect(detailed?.mediaVersions.map(({ label }) => label)).toEqual([
      "[Server 0] A",
      "[Server 1] B",
    ]);
    expect(paths.filter((path) => path.includes("AnyProviderIdEquals=tmdb.10"))).toHaveLength(2);
    for (const path of paths.filter((entry) => entry.includes("AnyProviderIdEquals=tmdb.10"))) {
      const parameters = new URL(path, "https://local").searchParams;
      expect(parameters.get("UserId")).toBe(
        parameters.get("ParentId") === "movies-0" ? "user-0" : "user-1",
      );
    }
    expect(paths.every((path) => !path.includes("SearchTerm="))).toBe(true);
  });

  it("keeps a known provider resource when its provider-ID filter is ignored", async () => {
    const now = 1_000;
    const layer = await setup(
      2,
      (serverId, path) => {
        if (path.includes("/Users/user-0/Items/primary-10")) {
          return Effect.succeed(
            item("primary-10", "Primary", {
              MediaSources: [{ Id: "source-a", Name: "A" }],
            }),
          );
        }
        if (path.includes("/Users/user-1/Items/known-copy-10")) {
          return Effect.succeed(
            item("known-copy-10", "Known copy", {
              MediaSources: [{ Id: "source-b", Name: "B" }],
            }),
          );
        }
        if (path.includes("AnyProviderIdEquals=")) {
          return Effect.succeed(
            serverId === "server-1"
              ? { Items: [item("unrelated-999", "Unrelated")], TotalRecordCount: 7_192 }
              : {
                  Items: [
                    item("primary-10", "Primary", {
                      MediaSources: [{ Id: "source-a", Name: "A" }],
                    }),
                  ],
                  TotalRecordCount: 1,
                },
          );
        }
        return Effect.succeed(
          serverId === "server-0"
            ? { Items: [item("primary-10", "Primary")], TotalRecordCount: 1 }
            : { Items: [item("known-copy-10", "Known copy")], TotalRecordCount: 1 },
        );
      },
      { now: () => now },
    );

    const page = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).list(query());
      }).pipe(Effect.provide(layer)),
    );
    const canonicalId = page.items[0]!.id;
    const detailed = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Federation).detail(canonicalId);
      }).pipe(Effect.provide(layer)),
    );

    expect(detailed?.mediaVersions.map(({ label }) => label)).toEqual([
      "[Server 0] A",
      "[Server 1] B",
    ]);
  });

  it.each([
    ["transient", true],
    ["auth", false],
    ["invalid", false],
  ] as const)("classifies %s direct known-item refreshes", async (failure, staleVisible) => {
    let now = 1_000;
    let directFailure: "none" | typeof failure = "none";
    const layer = await setup(
      2,
      (serverId, path) => {
        if (path.includes("/Users/user-1/Items/known-copy-10")) {
          if (directFailure === "transient")
            return Effect.fail(new UpstreamUnavailable({ serverId }));
          if (directFailure === "auth")
            return Effect.fail(new UpstreamRejected({ serverId, status: 401 }));
          if (directFailure === "invalid") return Effect.succeed({ invalid: true });
          return Effect.succeed(
            item("known-copy-10", "Known copy", {
              MediaSources: [{ Id: "source-b", Name: "B" }],
            }),
          );
        }
        if (path.includes("AnyProviderIdEquals=")) {
          if (serverId === "server-0")
            return Effect.succeed({
              Items: [
                item("primary-10", "Primary", {
                  MediaSources: [{ Id: "source-a", Name: "A" }],
                }),
              ],
              TotalRecordCount: 1,
            });
          return Effect.succeed(
            directFailure !== "none"
              ? { Items: [item("unrelated-999", "Unrelated")], TotalRecordCount: 7_192 }
              : {
                  Items: [
                    item("known-copy-10", "Known copy", {
                      MediaSources: [{ Id: "source-b", Name: "B" }],
                    }),
                  ],
                  TotalRecordCount: 1,
                },
          );
        }
        return Effect.succeed(
          serverId === "server-0"
            ? { Items: [item("primary-10", "Primary")], TotalRecordCount: 1 }
            : { Items: [item("known-copy-10", "Known copy")], TotalRecordCount: 1 },
        );
      },
      { now: () => now },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        expect(
          (yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label),
        ).toEqual(["[Server 0] A", "[Server 1] B"]);
        now += METADATA_FRESH_MS + 1;
        directFailure = failure;
        const refreshed = yield* federation.detail(page.items[0]!.id);
        expect(refreshed?.mediaVersions.map(({ label }) => label)).toEqual(
          staleVisible ? ["[Server 0] A", "[Server 1] B"] : ["[Server 0] A"],
        );
        expect(refreshed?.incompleteSourceIds).toEqual(["server-1"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.each([
    ["found and invalid", "found", "invalid", ["[Server 0] A", "[Server 1] B", "[Server 1] C"]],
    ["found and missing", "found", "missing", ["[Server 0] A", "[Server 1] B"]],
    [
      "transient and invalid",
      "transient",
      "invalid",
      ["[Server 0] A", "[Server 1] B", "[Server 1] C"],
    ],
  ] as const)(
    "keeps confirmed provider versions after %s direct refreshes",
    async (_description, goodOutcome, siblingOutcome, expectedLabels) => {
      let now = 1_000;
      let mixedFailure = false;
      let missingRefreshes = 0;
      const layer = await setup(
        2,
        (serverId, path) => {
          if (path.includes("/Users/user-1/Items/known-good-10")) {
            return mixedFailure && goodOutcome === "transient"
              ? Effect.fail(new UpstreamUnavailable({ serverId }))
              : Effect.succeed(
                  item("known-good-10", "Known good", {
                    MediaSources: [{ Id: "source-b", Name: "B" }],
                  }),
                );
          }
          if (path.includes("/Users/user-1/Items/known-invalid-10")) {
            if (!mixedFailure)
              return Effect.succeed(
                item("known-invalid-10", "Known invalid", {
                  MediaSources: [{ Id: "source-c", Name: "C" }],
                }),
              );
            if (siblingOutcome === "missing") {
              missingRefreshes++;
              return Effect.fail(new UpstreamNotFound({ serverId }));
            }
            return Effect.succeed({ invalid: true });
          }
          if (path.includes("AnyProviderIdEquals=")) {
            if (serverId === "server-0") {
              return Effect.succeed({
                Items: [
                  item("primary-10", "Primary", { MediaSources: [{ Id: "source-a", Name: "A" }] }),
                ],
                TotalRecordCount: 1,
              });
            }
            return Effect.succeed(
              mixedFailure
                ? { Items: [item("unrelated-999", "Unrelated")], TotalRecordCount: 7_192 }
                : {
                    Items: [
                      item("known-good-10", "Known good", {
                        MediaSources: [{ Id: "source-b", Name: "B" }],
                      }),
                      item("known-invalid-10", "Known invalid", {
                        MediaSources: [{ Id: "source-c", Name: "C" }],
                      }),
                    ],
                    TotalRecordCount: 2,
                  },
            );
          }
          return Effect.succeed(
            serverId === "server-0"
              ? { Items: [item("primary-10", "Primary")], TotalRecordCount: 1 }
              : {
                  Items: [
                    item("known-good-10", "Known good"),
                    item("known-invalid-10", "Known invalid"),
                  ],
                  TotalRecordCount: 2,
                },
          );
        },
        { now: () => now },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          const page = yield* federation.list(query());
          expect(
            (yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label),
          ).toEqual(["[Server 0] A", "[Server 1] B", "[Server 1] C"]);
          now += METADATA_FRESH_MS + 1;
          mixedFailure = true;
          const refreshed = yield* federation.detail(page.items[0]!.id);
          expect(refreshed?.mediaVersions.map(({ label }) => label)).toEqual(expectedLabels);
          expect(refreshed?.incompleteSourceIds).toEqual(["server-1"]);
          if (siblingOutcome === "missing") {
            const retried = yield* federation.detail(page.items[0]!.id);
            expect(retried?.mediaVersions.map(({ label }) => label)).toEqual(expectedLabels);
            expect(retried?.incompleteSourceIds).toEqual(["server-1"]);
            expect(missingRefreshes).toBe(2);
          }
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it("bounds direct known-item refreshes to one detail deadline", async () => {
    let directCalls = 0;
    const knownCopies = Array.from({ length: MAX_FANOUT_CONCURRENCY + 2 }, (_, index) =>
      item(`known-copy-${index}-10`, `Known copy ${index}`, { ProviderIds: { Tmdb: "10" } }),
    );
    const layer = await setup(
      1,
      (serverId, path) => {
        if (path.includes("/Users/user-0/Items/")) {
          directCalls++;
          return Effect.never;
        }
        if (path.includes("AnyProviderIdEquals=")) {
          return Effect.succeed({
            Items: [item("unrelated-999", "Unrelated")],
            TotalRecordCount: 9_999,
          });
        }
        return Effect.succeed({ Items: knownCopies, TotalRecordCount: knownCopies.length });
      },
      { detailDeadlineMs: 20 },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        const detailed = yield* federation.detail(page.items[0]!.id);
        expect(detailed?.incompleteSourceIds).toEqual(["server-0"]);
      }).pipe(Effect.provide(layer)),
    );

    expect(directCalls).toBeLessThanOrEqual(MAX_FANOUT_CONCURRENCY);
  });

  it("keeps direct known-item refreshes within global source fan-out", async () => {
    let active = 0;
    let peak = 0;
    const copies = [
      item("known-copy-a-10", "Known copy A"),
      item("known-copy-b-10", "Known copy B"),
    ];
    const layer = await setup(
      MAX_FANOUT_CONCURRENCY + 1,
      (serverId, path) => {
        if (path.includes("/Users/user-")) {
          return Effect.callback<unknown, UpstreamFailure>((resume) => {
            active++;
            peak = Math.max(peak, active);
            let complete = false;
            const timer = setTimeout(() => {
              complete = true;
              active--;
              resume(Effect.succeed(item("known-copy-a-10", "Known copy A")));
            }, 25);
            return Effect.sync(() => {
              clearTimeout(timer);
              if (!complete) active--;
            });
          });
        }
        if (path.includes("AnyProviderIdEquals=")) {
          return Effect.succeed({
            Items: [item("unrelated-999", "Unrelated")],
            TotalRecordCount: 9_999,
          });
        }
        return Effect.succeed({ Items: copies, TotalRecordCount: copies.length });
      },
      { detailDeadlineMs: 500 },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        yield* federation.detail(page.items[0]!.id);
      }).pipe(Effect.provide(layer)),
    );

    expect(peak).toBeLessThanOrEqual(MAX_FANOUT_CONCURRENCY);
  });

  it("exact-enriches a mapped item that has no current media versions and caches the positive result", async () => {
    let exactCalls = 0;
    const layer = await setup(1, (_serverId, path) => {
      if (path.includes("AnyProviderIdEquals=tmdb.10")) {
        exactCalls++;
        return Effect.succeed({
          Items: [
            item("movie-10", "Movie", {
              MediaSources: [{ Id: "source-a", Name: "A" }],
            }),
          ],
          TotalRecordCount: 1,
        });
      }
      return Effect.succeed({ Items: [item("movie-10", "Movie")], TotalRecordCount: 1 });
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        const first = yield* federation.detail(page.items[0]!.id);
        const second = yield* federation.detail(page.items[0]!.id);
        expect(first?.mediaVersions).toHaveLength(1);
        expect(second?.mediaVersions).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
    expect(exactCalls).toBe(1);
  });

  it("keeps successful exact enrichments when another source returns an invalid response", async () => {
    const layer = await setup(3, (serverId, path) => {
      if (!path.includes("AnyProviderIdEquals=")) {
        return Effect.succeed(
          serverId === "server-0"
            ? {
                Items: [
                  item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] }),
                ],
                TotalRecordCount: 1,
              }
            : { Items: [], TotalRecordCount: 0 },
        );
      }
      if (serverId === "server-1") return Effect.succeed({ invalid: true });
      if (serverId === "server-0")
        return Effect.succeed({
          Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
          TotalRecordCount: 1,
        });
      return Effect.succeed({
        Items: [item("copy-10", "Movie", { MediaSources: [{ Id: "source-c", Name: "C" }] })],
        TotalRecordCount: 1,
      });
    });
    const detailed = await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        return yield* federation.detail(page.items[0]!.id);
      }).pipe(Effect.provide(layer)),
    );
    expect(detailed?.mediaVersions.map(({ label }) => label)).toEqual([
      "[Server 0] A",
      "[Server 2] C",
    ]);
    expect(detailed?.incompleteSourceIds).toEqual(["server-1"]);
  });

  it("does not expose expired exact versions after a transient refresh failure", async () => {
    let now = 1_000;
    let unavailable = false;
    const layer = await setup(
      1,
      (serverId) =>
        unavailable
          ? Effect.fail(new UpstreamUnavailable({ serverId }))
          : Effect.succeed({
              Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
              TotalRecordCount: 1,
            }),
      { now: () => now },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions).toHaveLength(1);
        now += METADATA_STALE_MS + 1;
        unavailable = true;
        const expired = yield* federation.detail(page.items[0]!.id);
        expect(expired?.mediaVersions).toEqual([]);
        expect(expired?.incompleteSourceIds).toEqual(["server-0"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("hides a version omitted by the latest successful detail projection", async () => {
    let now = 1_000;
    let mediaSources: ReadonlyArray<{ readonly Id: string; readonly Name: string }> = [
      { Id: "source-a", Name: "A" },
    ];
    const layer = await setup(
      1,
      (_serverId, path) =>
        Effect.succeed(
          path.includes("AnyProviderIdEquals=")
            ? {
                Items: [item("movie-10", "Movie", { MediaSources: mediaSources })],
                TotalRecordCount: 1,
              }
            : { Items: [item("movie-10")], TotalRecordCount: 1 },
        ),
      { now: () => now },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const federation = yield* Federation;
        const page = yield* federation.list(query());
        expect(
          (yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label),
        ).toEqual(["[Server 0] A"]);
        now += METADATA_FRESH_MS + 1;
        mediaSources = [];
        expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.each([
    ["transient", true],
    ["auth", false],
    ["not-found", false],
    ["invalid", false],
  ] as const)(
    "classifies %s exact refreshes when exposing stale detail versions",
    async (failure, visible) => {
      let now = 1_000;
      let mode: "success" | typeof failure = "success";
      const layer = await setup(
        1,
        (serverId, path) => {
          if (!path.includes("AnyProviderIdEquals=")) {
            return Effect.succeed({ Items: [item("movie-10")], TotalRecordCount: 1 });
          }
          if (mode === "transient") return Effect.fail(new UpstreamUnavailable({ serverId }));
          if (mode === "auth") return Effect.fail(new UpstreamRejected({ serverId, status: 401 }));
          if (mode === "not-found") return Effect.fail(new UpstreamNotFound({ serverId }));
          if (mode === "invalid") return Effect.succeed({ invalid: true });
          return Effect.succeed({
            Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
            TotalRecordCount: 1,
          });
        },
        { now: () => now },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          const page = yield* federation.list(query());
          expect(
            (yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label),
          ).toEqual(["[Server 0] A"]);
          now += METADATA_FRESH_MS + 1;
          mode = failure;
          const refreshed = yield* federation.detail(page.items[0]!.id);
          expect(refreshed?.mediaVersions.map(({ label }) => label)).toEqual(
            visible ? ["[Server 0] A"] : [],
          );
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.each([
    ["transient", ["[Server 0] A", "[Server 0] B"]],
    ["auth", []],
    ["not-found", []],
    ["invalid", []],
  ] as const)(
    "classifies %s refreshes across sibling detail projections",
    async (failure, expected) => {
      let now = 1_000;
      let mode: "success" | typeof failure = "success";
      const siblings = (withVersions: boolean) => [
        item("copy-a", "A", {
          ProviderIds: { Tmdb: "10" },
          ...(withVersions ? { MediaSources: [{ Id: "source-a", Name: "A" }] } : {}),
        }),
        item("copy-b", "B", {
          ProviderIds: { Tmdb: "10" },
          ...(withVersions ? { MediaSources: [{ Id: "source-b", Name: "B" }] } : {}),
        }),
      ];
      const layer = await setup(
        1,
        (serverId, path) => {
          if (!path.includes("AnyProviderIdEquals=")) {
            return Effect.succeed({ Items: siblings(false), TotalRecordCount: 2 });
          }
          if (mode === "transient") return Effect.fail(new UpstreamUnavailable({ serverId }));
          if (mode === "auth") return Effect.fail(new UpstreamRejected({ serverId, status: 401 }));
          if (mode === "not-found") return Effect.fail(new UpstreamNotFound({ serverId }));
          if (mode === "invalid") return Effect.succeed({ invalid: true });
          return Effect.succeed({ Items: siblings(true), TotalRecordCount: 2 });
        },
        { now: () => now },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const federation = yield* Federation;
          const page = yield* federation.list(query());
          expect(
            (yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label),
          ).toEqual(["[Server 0] A", "[Server 0] B"]);
          now += METADATA_FRESH_MS + 1;
          mode = failure;
          const refreshed = yield* federation.detail(page.items[0]!.id);
          expect(refreshed?.mediaVersions.map(({ label }) => label)).toEqual(expected);
        }).pipe(Effect.provide(layer)),
      );
    },
  );
});
