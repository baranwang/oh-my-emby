import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js";
import type { CanonicalItemView } from "../src/core/federation.js";

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "sen-device",
  deviceName: "SenPlayer",
};

const item = (
  id: string,
  type = "Movie",
  extra: Partial<CanonicalItemView> = {},
): CanonicalItemView => ({
  id,
  itemType: type,
  displayMetadata: {
    Name: `${type} ${id}`,
    Path: "file:///srv/private/private-token/movie.mkv",
    SeriesId: "upstream-series-id",
    SeasonId: "upstream-season-id",
    SecretEnvelope: {
      ServerId: "upstream-server-id",
      Path: "/srv/private/private-token/movie.mkv",
      Token: "private-token",
    },
    UserData: { IsFavorite: false, Played: true },
    MediaSources: [{ Id: "untrusted-upstream-version" }],
  },
  mediaVersions: [
    {
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
        DirectStreamUrl: "/Videos/upstream-id/stream?api_key=private-token",
      },
      streams: [
        {
          Index: 0,
          Type: "Video",
          Codec: "h264",
          Path: "/srv/private/private-token/movie.mkv",
          Url: "https://upstream.example/stream?token=private-token",
          Token: "private-token",
          Server: { Id: "upstream-server-id", Token: "private-token" },
        },
      ],
      updatedAtMs: 1_000,
    },
  ],
  userState: {
    canonicalId: id,
    revision: 3,
    played: false,
    favorite: true,
    playCount: 2,
    positionTicks: 42,
    lastPlayedVersionId: `version-${id}`,
    updatedAtMs: 1_000,
  },
  incompleteSourceIds: [],
  ...extra,
});

const services = (overrides: Partial<EmbyServices> = {}): EmbyServices => ({
  config: { serverId: "virtual-server", serverName: "Oh My Emby", version: "0.0.0" },
  now: () => 1_234,
  auth: {
    loginEmby: () => Effect.die("unused"),
    authenticateEmby: () => Effect.succeed(principal),
  },
  federation: {
    list: () =>
      Effect.succeed({
        items: [item("movie-1")],
        totalRecordCount: 1,
        exhausted: true,
        incompleteSourceIds: [],
      }),
    search: () =>
      Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    studios: () =>
      Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    detail: (id) => Effect.succeed(item(id)),
    lookupMembership: (id, versionId) => {
      const value = item(id);
      const version =
        versionId === undefined
          ? null
          : (value.mediaVersions.find(({ id }) => id === versionId) ?? null);
      return Effect.succeed(
        versionId !== undefined && version === null ? null : { item: value, version },
      );
    },
  },
  userState: {
    write: () => Effect.die("unused"),
    recordPlaybackEvent: () => Effect.die("unused"),
  },
  libraries: {
    list: () =>
      Effect.succeed([
        {
          id: "library-1" as any,
          name: "Movies",
          mediaType: "movies",
          enabled: true,
          sources: [],
        },
      ]),
  },
  playback: {
    getInfo: () =>
      Effect.succeed({ playSessionId: "play-session", mediaSources: [{ Id: "version-movie-1" }] }),
  },
  ...overrides,
});

const get = (path: string, token = "token") =>
  new Request(`https://local${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe("Emby library covers", () => {
  const cover = { body: new Uint8Array([1, 2, 3]), revision: "new-revision" };
  const setup = (enabled = true, hasCover = true) => {
    const base = services();
    return makeEmbyHandler(
      services({
        libraries: {
          list: () =>
            base.libraries.list().pipe(
              Effect.map((ls) =>
                ls.map((l) => ({
                  ...l,
                  enabled,
                  ...(hasCover
                    ? {
                        cover: {
                          revision: cover.revision,
                          width: 1920 as const,
                          height: 1080 as const,
                          stale: false,
                        },
                      }
                    : {}),
                })),
              ),
            ),
        },
        libraryCovers: { read: () => Effect.succeed(hasCover ? (cover as any) : null) },
      }),
    );
  };
  it("uses consistent image fields on Views, details and VirtualFolders", async () => {
    const app = setup();
    for (const path of ["/Users/owner/Views", "/Items/library-1", "/Library/VirtualFolders"]) {
      const body = await (await Effect.runPromise(app(get(path)))).json();
      const dto = body.Items?.[0] ?? (Array.isArray(body) ? body[0] : body);
      expect(dto.ImageTags).toEqual({ Primary: cover.revision });
      expect(dto.PrimaryImageAspectRatio).toBe(16 / 9);
    }
    const body = await (
      await Effect.runPromise(setup(true, false)(get("/Items/library-1")))
    ).json();
    expect(body.ImageTags).toBeUndefined();
  });
  it("serves current bytes with revalidation for old tags, HEAD and 304", async () => {
    const app = setup();
    for (const prefix of ["", "/emby"]) {
      const url = `https://local${prefix}/Items/library-1/Images/Primary/0?tag=old`;
      const r = await Effect.runPromise(
        app(new Request(url, { headers: { authorization: "Bearer token" } })),
      );
      expect(r.status).toBe(200);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(cover.body);
      expect(r.headers.get("cache-control")).toBe("private, no-cache");
      expect(r.headers.get("etag")).toBe('"new-revision"');
      const head = await Effect.runPromise(
        app(new Request(url, { method: "HEAD", headers: { authorization: "Bearer token" } })),
      );
      expect(head.headers.get("content-length")).toBe("3");
      expect(await head.text()).toBe("");
      expect(
        (
          await Effect.runPromise(
            app(
              new Request(url, {
                headers: { authorization: "Bearer token", "if-none-match": '"new-revision"' },
              }),
            ),
          )
        ).status,
      ).toBe(304);
    }
  });
  it("rejects unauthenticated, disabled, missing and unsupported images", async () => {
    expect(
      (
        await Effect.runPromise(
          setup()(new Request("https://local/Items/library-1/Images/Primary")),
        )
      ).status,
    ).toBe(401);
    for (const app of [setup(false), setup(true, false)])
      expect((await Effect.runPromise(app(get("/Items/library-1/Images/Primary")))).status).toBe(
        404,
      );
    for (const suffix of ["Primary/1", "Backdrop"])
      expect(
        (await Effect.runPromise(setup()(get(`/Items/library-1/Images/${suffix}`)))).status,
      ).toBe(404);
  });
  it("preserves normal movie image routing", async () => {
    const base = services();
    const resolveImage = vi.fn(() =>
      Effect.succeed({
        _tag: "Redirect" as const,
        location: new URL("https://upstream.example/poster.jpg"),
      }),
    );
    const app = makeEmbyHandler(services({ playback: { ...base.playback, resolveImage } }));
    expect((await Effect.runPromise(app(get("/Items/movie-1/Images/Primary")))).status).toBe(302);
    expect(resolveImage).toHaveBeenCalledOnce();
  });
});
