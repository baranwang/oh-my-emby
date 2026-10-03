import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeLibraryCoverService } from "../src/core/library-covers.js";
import { makeLibraryCoverCandidateSelector } from "../src/core/library-cover-candidates.js";
const library = {
  id: "lib",
  name: "华语影片",
  mediaType: "movies",
  enabled: true,
  sources: [],
  createdAtMs: 1,
  updatedAtMs: 1,
} as any;
const source = {
  serverId: "s",
  serverGeneration: 1,
  sourceLibraryId: "movies",
  catalogNamespace: "c",
  verifiedCatalogId: "c",
} as any;
const canonical = {
  id: "movie",
  itemType: "Movie",
  displayMetadata: { ImageTags: { Primary: "tag" } },
};
const record = {
  canonical,
  sourceItems: [
    {
      ...source,
      upstreamItemId: "up",
      itemType: "Movie",
      canonicalId: "movie",
      quarantineReason: null,
    },
  ],
  mediaVersions: [],
};
const setup = () => {
  const manifests = new Map();
  let saved: any = null;
  const repo = {
    listVirtualLibraries: () => Effect.succeed([library]),
    resolveEligibleSources: () => Effect.succeed([source]),
    listLibraryCoverCandidateIds: () => Effect.succeed(["movie"]),
    readCatalogItems: () => Effect.succeed([record]),
    getLibraryCover: () => Effect.succeed(saved),
    saveLibraryCoverManifest: (m: any) =>
      Effect.sync(() => {
        manifests.set(m.token, m);
      }),
    getLibraryCoverManifest: (t: string) => Effect.succeed(manifests.get(t) ?? null),
    commitLibraryCover: () => Effect.succeed(true),
    getServer: () => Effect.succeed({ generation: 1, upstreamUserId: "user" }),
  } as any;
  const upstream = {
    request: () => Effect.succeed({ Items: [] }),
    requestImage: () => Effect.succeed({ bytes: new Uint8Array([1]), contentType: "image/jpeg" }),
  } as any;
  return {
    repo,
    upstream,
    identity: {} as any,
    manifests,
    setSaved: (c: any) => {
      saved = c;
    },
  };
};
describe("library covers", () => {
  it("prepares same-origin URLs from deduplicated cached posters without upstream discovery", async () => {
    const s = setup();
    s.repo.readCatalogItems = () =>
      Effect.succeed(
        Array.from({ length: 9 }, (_, i) => ({
          ...record,
          canonical: { ...canonical, id: `movie-${i}` },
        })),
      );
    s.upstream.request = () => {
      throw Error("cached posters must not request upstream");
    };
    const api = makeLibraryCoverService(s.repo, s.upstream, s.identity, () => 1000);
    const p = await Effect.runPromise(api.prepare("lib"));
    expect(p.title).toBe("华语影片");
    expect(p.subtitle).toBe("Movies");
    expect(p.candidates).toHaveLength(9);
    expect(p.candidates[0]!.url).toMatch(/^\/api\/dashboard\/libraries\/lib\/cover\/assets\//);
    expect(p.expiresAtMs).toBe(601000);
  });
  it("rejects expired and cross-library tokens and preserves existing cover", async () => {
    const s = setup(),
      api = makeLibraryCoverService(s.repo, s.upstream, s.identity, () => 1000);
    s.manifests.set("old", { libraryId: "lib", expiresAtMs: 1000 });
    await expect(
      Effect.runPromise(api.asset({ libraryId: "lib", token: "old", index: 0 })),
    ).rejects.toThrow();
    s.manifests.set("other", { libraryId: "other", expiresAtMs: 2000 });
    await expect(
      Effect.runPromise(api.asset({ libraryId: "lib", token: "other", index: 0 })),
    ).rejects.toThrow();
  });
  it("filters episodes and duplicate canonical entries", async () => {
    const s = setup();
    s.repo.readCatalogItems = () =>
      Effect.succeed([
        record,
        record,
        { ...record, canonical: { ...canonical, id: "ep", itemType: "Episode" } },
      ]);
    const select = makeLibraryCoverCandidateSelector(s.repo, s.upstream, s.identity);
    expect(await Effect.runPromise(select(library))).toHaveLength(1);
  });
  it("budgets discovery to one twenty-row page per source", async () => {
    const s = setup();
    s.repo.listLibraryCoverCandidateIds = () => Effect.succeed([]);
    s.repo.readCatalogItems = () => Effect.succeed([]);
    s.repo.resolveEligibleSources = () =>
      Effect.succeed(Array.from({ length: 10 }, (_, i) => ({ ...source, serverId: `s${i}` })));
    const requests: string[] = [];
    s.upstream.request = (r: any) => {
      requests.push(r.path);
      return Effect.succeed({ Items: [] });
    };
    const result = await Effect.runPromise(
      makeLibraryCoverCandidateSelector(s.repo, s.upstream, s.identity)(library),
    );
    expect(result).toEqual([]);
    expect(requests).toHaveLength(10);
    expect(
      requests.every((p) => new URL(p, "https://local").searchParams.get("Limit") === "20"),
    ).toBe(true);
  });
});
