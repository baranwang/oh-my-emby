import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js";
import { ApplicationServices, routeApplication } from "../src/api/application.js";
import { InvalidCredentials } from "../src/core/errors.js";
import { FederationUnavailable, type CanonicalItemView } from "../src/core/federation.js";
import { makeMemoryDrivembyCompat } from "../src/core/drivemby-compat.js";

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "sen-device",
  deviceName: "SenPlayer",
};

const state = {
  canonicalId: "movie-1",
  revision: 1,
  played: false,
  favorite: false,
  playCount: 0,
  positionTicks: 0,
  lastPlayedVersionId: null,
  updatedAtMs: 1,
};

const mediaItemType = (id: string): CanonicalItemView["itemType"] => {
  if (id.startsWith("series")) return "Series";
  if (id.startsWith("episode")) return "Episode";
  return "Movie";
};

const media = (id: string): CanonicalItemView => ({
  id,
  itemType: mediaItemType(id),
  displayMetadata: {
    Name: id,
    ParentIndexNumber: id === "episode-special" ? 0 : 1,
    IndexNumber: id === "episode-2" ? 2 : 1,
    RunTimeTicks: 10_000_000,
  },
  mediaVersions: [
    {
      id: `version-${id}`,
      sourceItemId: `source-${id}`,
      serverGeneration: 1,
      upstreamMediaSourceId: `upstream-${id}`,
      label: "Server A",
      capabilities: { Id: `version-${id}`, Container: "mkv" },
      streams: [],
      updatedAtMs: 1,
    },
  ],
  userState: { ...state, canonicalId: id },
  incompleteSourceIds: [],
});

const emptyPage = { items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] };

const services = (overrides: Partial<EmbyServices> = {}): EmbyServices => ({
  config: { serverId: "virtual-server", serverName: "Oh My Emby", version: "0.0.0" },
  now: () => 1_700_000_000_000,
  auth: {
    loginEmby: () => Effect.fail(new InvalidCredentials()),
    authenticateEmby: () => Effect.succeed(principal),
    authenticateDashboard: (token) =>
      token === "console-token"
        ? Effect.succeed({ id: "session", username: "owner", authGeneration: 1, expiresAtMs: 9 })
        : Effect.fail(new InvalidCredentials()),
    issueEmbySession: () =>
      Effect.succeed({
        accessToken: "connection-token",
        userId: "owner",
        expiresAtMs: 9,
        tokenId: "issued-token",
      }),
  },
  federation: {
    counts: () => Effect.succeed({ MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, ItemCount: 0 }),
    list: () => Effect.succeed(emptyPage),
    search: () => Effect.succeed(emptyPage),
    studios: () => Effect.succeed(emptyPage),
    detail: (id) => Effect.succeed(id === "movie-1" ? media("movie-1") : null),
    lookupMembership: (id) =>
      Effect.succeed(
        id === "movie-1" || id === "series-1"
          ? { item: media(id), version: media(id).mediaVersions[0]! }
          : null,
      ),
    showChildren: () =>
      Effect.succeed({
        ...emptyPage,
        items: [media("episode-1")],
        totalRecordCount: 1,
      }),
  },
  userState: {
    write: () => Effect.die("unused"),
    recordPlaybackEvent: () => Effect.void,
  },
  libraries: { list: () => Effect.succeed([]) },
  playback: {
    getInfo: (_id, clientUserAgent) =>
      Effect.succeed({
        playSessionId: "play-session",
        mediaSources: [
          {
            Id: "version-movie-1",
            Name: "Server A",
            Container: "mkv",
            Path: "/Videos/movie-1/stream?MediaSourceId=version-movie-1",
            DirectStreamUrl: "/Videos/movie-1/stream?MediaSourceId=version-movie-1",
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: false,
            ...(clientUserAgent === undefined ? {} : { PlaybackUserAgent: clientUserAgent }),
          },
        ],
      }),
    resolveImage: () =>
      Effect.succeed({
        _tag: "Redirect" as const,
        location: new URL("https://images.example/primary.jpg"),
      }),
  },
  compat: makeMemoryDrivembyCompat(),
  ...overrides,
});

const auth = { authorization: "Bearer token" };

const get = (path: string, headers: HeadersInit = auth) =>
  new Request(`https://local.example${path}`, { headers });

const send = (app: ReturnType<typeof makeEmbyHandler>, request: Request) =>
  Effect.runPromise(app(request));

describe("Drivemby compatible routes", () => {
  it.each([
    ["/emby/Users/owner/Items", "Movie", 1, 2802],
    ["/Users/owner/Items", "Series", 1, 4385],
    ["/Items", "Movie", 0, 2802],
    ["/emby/Items", "Series", 0, 4385],
    ["/Items", "Episode", 0, 147618],
    ["/Items", "Movie,Series,Movie", 0, 7187],
  ])(
    "returns whole-server totals for a client count probe at %s (%s, limit %s)",
    async (path, type, limit, total) => {
      const base = services();
      const calls: Array<string> = [];
      const app = makeEmbyHandler({
        ...base,
        federation: {
          ...base.federation,
          counts: (agent) => {
            calls.push(`counts:${agent}`);
            return Effect.succeed({ MovieCount: 2802, SeriesCount: 4385, EpisodeCount: 147618 });
          },
          list: () => {
            calls.push("list");
            return Effect.succeed({
              ...emptyPage,
              items: [media("movie-1")],
              totalRecordCount: 2,
              exhausted: false,
            });
          },
        },
      });
      const response = await send(
        app,
        get(
          `${path}?Recursive=true&IncludeItemTypes=${type}&Limit=${limit}&EnableTotalRecordCount=true&Fields=ProviderIds&SortBy=SortName&EnableImages=false`,
          { ...auth, "user-agent": "SenPlayer/6.2.2" },
        ),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.TotalRecordCount).toBe(total);
      expect(body.StartIndex).toBe(0);
      expect(body.Items).toHaveLength(limit);
      expect(calls.filter((call) => call.startsWith("counts:"))).toEqual([
        "counts:SenPlayer/6.2.2",
      ]);
      expect(calls.includes("list")).toBe(limit === 1);
    },
  );

  it.each([
    "ParentId=library-1",
    "Filters=IsFavorite",
    "SearchTerm=movie",
    "Studios=studio",
    "IsWatchlisted=true",
    "IsWatchlisted=false",
    "StartIndex=1",
    "Limit=30",
    "Recursive=false",
    "EnableTotalRecordCount=false",
    "IncludeItemTypes=Season",
    "IncludeItemTypes=Movie,Video",
    "ExcludeItemIds=movie-1",
  ])("keeps scoped or filtered query totals when %s", async (restriction) => {
    const base = services();
    let countCalls = 0;
    const page = { ...emptyPage, totalRecordCount: 2 };
    const app = makeEmbyHandler({
      ...base,
      federation: {
        ...base.federation,
        counts: () => {
          countCalls++;
          return Effect.succeed({ MovieCount: 2802, SeriesCount: 4385, EpisodeCount: 147618 });
        },
        list: () => Effect.succeed(page),
        search: () => Effect.succeed(page),
      },
    });
    const parameters = new URLSearchParams({
      Recursive: "true",
      IncludeItemTypes: "Movie",
      Limit: "1",
    });
    for (const [key, value] of new URLSearchParams(restriction)) parameters.set(key, value);
    const response = await send(app, get(`/Users/owner/Items?${parameters}`));
    expect(response.status).toBe(200);
    expect((await response.json()).TotalRecordCount).toBe(2);
    expect(countCalls).toBe(0);
  });

  it.each(["UserId", "userId"])(
    "accepts the %s count-probe identity and rejects other users",
    async (key) => {
      const base = services();
      let countCalls = 0;
      const app = makeEmbyHandler({
        ...base,
        federation: {
          ...base.federation,
          counts: () => {
            countCalls++;
            return Effect.succeed({ MovieCount: 2802, SeriesCount: 4385, EpisodeCount: 147618 });
          },
        },
      });
      const path = `/Items?Recursive=true&IncludeItemTypes=Movie&Limit=0&${key}=`;
      const valid = await send(app, get(`${path}owner`));
      expect(valid.status).toBe(200);
      expect((await valid.json()).TotalRecordCount).toBe(2802);
      expect((await send(app, get(`${path}other-user`))).status).toBe(403);
      expect((await send(app, new Request(`https://local.example${path}owner`))).status).toBe(401);
      expect(countCalls).toBe(1);
    },
  );

  it("fails a client count probe instead of exposing a pagination estimate when counts are unavailable", async () => {
    const base = services();
    const app = makeEmbyHandler({
      ...base,
      federation: {
        ...base.federation,
        counts: () => Effect.fail(new FederationUnavailable({ sourceIds: ["server-1"] })),
      },
    });
    const response = await send(
      app,
      get("/Users/owner/Items?Recursive=true&IncludeItemTypes=Movie&Limit=1"),
    );
    expect(response.status).toBe(503);
  });

  it("advertises the project icon in user profiles and serves it as the primary avatar", async () => {
    const app = makeEmbyHandler(services());
    const profile = await send(app, get("/emby/Users/owner"));
    const user = (await profile.json()) as {
      PrimaryImageTag?: string;
      PrimaryImageAspectRatio?: number;
    };
    expect(user.PrimaryImageTag).toEqual(expect.any(String));
    expect(user.PrimaryImageTag).toBe("ohmyemby-logo-png-v1");
    expect(user.PrimaryImageAspectRatio).toBe(1);
    const avatar = await send(
      app,
      get(`/emby/Users/owner/Images/Primary?tag=${user.PrimaryImageTag}`),
    );
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await avatar.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dimensions = new DataView(bytes.buffer);
    expect(dimensions.getUint32(16)).toBe(512);
    expect(dimensions.getUint32(20)).toBe(512);
    expect(bytes).toEqual(
      new Uint8Array(
        await Bun.file(new URL("../../../assets/brand/logo.png", import.meta.url)).arrayBuffer(),
      ),
    );
  });

  it.each(["/Items/Counts", "/emby/Items/Counts?UserId=owner"])(
    "returns whole-server counts from federation instead of the local cache at %s",
    async (path) => {
      const agents: Array<string | undefined> = [];
      const base = services();
      const app = makeEmbyHandler({
        ...base,
        federation: {
          ...base.federation,
          counts: (clientUserAgent) => {
            agents.push(clientUserAgent);
            return Effect.succeed({
              MovieCount: 2802,
              SeriesCount: 4385,
              EpisodeCount: 147618,
              ItemCount: 161033,
            });
          },
        },
      });
      const response = await send(app, get(path, { ...auth, "user-agent": "Rex-Standard/0.5.0" }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        MovieCount: 2802,
        SeriesCount: 4385,
        EpisodeCount: 147618,
        ItemCount: 161033,
      });
      expect(agents).toEqual(["Rex-Standard/0.5.0"]);
      expect((await send(app, new Request(`https://local.example${path}`))).status).toBe(401);
      expect((await send(app, get("/Items/Counts?UserId=other-user"))).status).toBe(403);
      expect(agents).toHaveLength(1);
    },
  );

  it("returns unavailable instead of a misleading zero count when federation fails", async () => {
    const base = services();
    const app = makeEmbyHandler({
      ...base,
      federation: {
        ...base.federation,
        counts: () => Effect.fail(new FederationUnavailable({ sourceIds: ["server-1"] })),
      },
    });
    const response = await send(app, get("/Items/Counts"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "Unavailable", message: "Service unavailable" },
    });
  });

  it("serves public users and item counts without the shadowing routes", async () => {
    const app = makeEmbyHandler(services());
    const pub = await send(app, new Request("https://local.example/Users/Public"));
    expect(pub.status).toBe(200);
    await expect(pub.json()).resolves.toEqual([]);
    const prefixed = await send(app, new Request("https://local.example/emby/Users/Public"));
    await expect(prefixed.json()).resolves.toEqual([]);

    const counts = await send(app, get("/Items/Counts"));
    expect(counts.status).toBe(200);
    await expect(counts.json()).resolves.toEqual({
      MovieCount: 0,
      SeriesCount: 0,
      EpisodeCount: 0,
      ItemCount: 0,
    });
    const missing = await send(app, get("/Items/not-a-count"));
    expect(missing.status).toBe(404);
  });

  it("requires a session for ping, logout, and playback ping", async () => {
    const deleted: Array<string> = [];
    const base = services();
    const app = makeEmbyHandler({
      ...base,
      compat: {
        ...base.compat!,
        deleteEmbyToken: (id) =>
          Effect.sync(() => {
            deleted.push(id);
          }),
      },
    });
    expect((await send(app, new Request("https://local.example/System/Ping"))).status).toBe(401);
    const ping = await send(app, get("/System/Ping"));
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toBe("Emby Server");
    const post = await send(
      app,
      new Request("https://local.example/emby/System/Ping", { method: "POST", headers: auth }),
    );
    await expect(post.json()).resolves.toBe("Emby Server");

    const heartbeat = await send(
      app,
      new Request("https://local.example/Sessions/Playing/Ping", {
        method: "POST",
        headers: auth,
      }),
    );
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toEqual({});

    const logout = await send(
      app,
      new Request("https://local.example/Sessions/Logout", { method: "POST", headers: auth }),
    );
    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toBe("");
    expect(deleted).toEqual(["token-id"]);
  });

  it("returns server domains, empty additional parts, genres, and the default avatar", async () => {
    const app = makeEmbyHandler(services());
    const domains = await send(app, get("/System/Ext/ServerDomains"));
    await expect(domains.json()).resolves.toEqual({
      ok: true,
      data: [{ name: "Oh My Emby", url: "https://local.example" }],
    });
    const parts = await send(app, get("/Videos/movie-1/AdditionalParts"));
    await expect(parts.json()).resolves.toEqual([]);
    expect((await send(app, get("/Videos/missing/AdditionalParts"))).status).toBe(404);
    const genres = await send(app, get("/Genres?Limit=10"));
    await expect(genres.json()).resolves.toMatchObject({
      Items: [],
      TotalRecordCount: 0,
      StartIndex: 0,
    });

    const avatar = await send(app, get("/Users/owner/Images/Primary"));
    expect(avatar.headers.get("content-type")).toBe("image/png");
    expect((await avatar.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const head = await send(
      app,
      new Request("https://local.example/Users/owner/Images/Primary/0", {
        method: "HEAD",
        headers: auth,
      }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("content-length")).toBe(avatar.headers.get("content-length"));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await send(app, get("/Users/owner/Images/Backdrop"))).status).toBe(404);
    expect((await send(app, get("/Users/other/Images/Primary"))).status).toBe(403);
  });

  it("answers image HEAD with the GET headers and an empty body", async () => {
    const app = makeEmbyHandler(services());
    const head = await send(
      app,
      new Request("https://local.example/Items/movie-1/Images/Primary", {
        method: "HEAD",
        headers: auth,
      }),
    );
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe("https://images.example/primary.jpg");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("keeps GET and POST PlaybackInfo on the same playable URL", async () => {
    let agent: string | undefined;
    const base = services();
    const app = makeEmbyHandler({
      ...base,
      playback: {
        ...base.playback,
        getInfo: (_id, clientUserAgent) => {
          agent = clientUserAgent;
          return base.playback.getInfo(_id, clientUserAgent);
        },
      },
    });
    const response = await send(
      app,
      get(
        "/Items/movie-1/PlaybackInfo?UserId=owner&MediaSourceId=version-movie-1&PlaybackUserAgent=Player%2F1",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { MediaSources: Array<Record<string, unknown>> };
    expect(body.MediaSources).toHaveLength(1);
    expect(body.MediaSources[0]?.DirectStreamUrl).toBe(
      "https://local.example/Videos/movie-1/stream?MediaSourceId=version-movie-1",
    );
    expect(body.MediaSources[0]?.Path).toBe(body.MediaSources[0]?.DirectStreamUrl);
    expect(body.MediaSources[0]?.RequiredHttpHeaders).toEqual({ "User-Agent": "Player/1" });
    expect(agent).toBe("Player/1");

    const mismatch = await send(
      app,
      new Request(
        "https://local.example/Items/movie-1/PlaybackInfo?MediaSourceId=version-movie-1",
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ MediaSourceId: "other" }),
        },
      ),
    );
    expect(mismatch.status).toBe(400);
    const missing = await send(app, get("/Items/movie-1/PlaybackInfo?MediaSourceId=missing"));
    expect(missing.status).toBe(404);
  });

  it("hides resume items and keeps an independent watchlist", async () => {
    const movie = media("movie-1");
    const base = services();
    const app = makeEmbyHandler({
      ...base,
      federation: {
        ...base.federation,
        list: () => Effect.succeed({ ...emptyPage, items: [movie], totalRecordCount: 1 }),
        detail: () => Effect.succeed(movie),
      },
    });
    const hidden = await send(
      app,
      new Request("https://local.example/Users/owner/Items/movie-1/HideFromResume?Hide=true", {
        method: "POST",
        headers: auth,
      }),
    );
    expect(hidden.status).toBe(200);
    await expect(hidden.json()).resolves.toMatchObject({
      PlaybackPositionTicks: 0,
      IsWatchlisted: false,
    });
    const resume = await send(app, get("/Users/owner/Items/Resume"));
    await expect(resume.json()).resolves.toMatchObject({ Items: [], TotalRecordCount: 0 });

    const added = await send(
      app,
      new Request("https://local.example/Users/owner/WatchlistItems/movie-1", {
        method: "POST",
        headers: auth,
      }),
    );
    await expect(added.json()).resolves.toMatchObject({ IsWatchlisted: true, Played: false });
    const list = await send(app, get("/Users/owner/Watchlist"));
    const listed = (await list.json()) as {
      Items: Array<{ UserData: { IsWatchlisted: boolean } }>;
    };
    expect(listed.Items).toHaveLength(1);
    expect(listed.Items[0]?.UserData.IsWatchlisted).toBe(true);
    const filtered = await send(app, get("/Items?IsWatchlisted=true"));
    await expect(filtered.json()).resolves.toMatchObject({
      Items: [{ Id: "movie-1", UserData: { IsWatchlisted: true } }],
    });
  });

  it("records one playback history row per session and clears it by time", async () => {
    let clock = 1_700_000_000_000;
    const movie = media("movie-1");
    const base = services();
    const app = makeEmbyHandler({
      ...base,
      now: () => clock,
      federation: {
        ...base.federation,
        lookupMembership: (id, versionId) =>
          Effect.succeed(
            id === "movie-1" && (versionId === undefined || versionId === "version-movie-1")
              ? { item: movie, version: movie.mediaVersions[0]! }
              : null,
          ),
      },
    });
    const play = (session: string, kind: string) =>
      send(
        app,
        new Request(`https://local.example/Sessions/Playing${kind}`, {
          method: "POST",
          headers: {
            ...auth,
            "content-type": "application/json",
            "x-emby-authorization":
              'MediaBrowser Client="SenPlayer", Device="iPhone", DeviceId="sen-device", Version="3"',
          },
          body: JSON.stringify({
            ItemId: "movie-1",
            MediaSourceId: "version-movie-1",
            PlaySessionId: session,
            PositionTicks: 100,
          }),
        }),
      );
    expect((await play("session-a", "")).status).toBe(204);
    clock += 1_000;
    expect((await play("session-b", "")).status).toBe(204);
    const page = await send(app, get("/Users/owner/PlaybackHistory?Limit=1"));
    const body = (await page.json()) as {
      Items: Array<{ Id: string; Name: string }>;
      NextCursor: string | null;
    };
    expect(body.Items).toHaveLength(1);
    expect(body.NextCursor).toEqual(expect.any(String));
    const both = await send(
      app,
      get(`/Users/owner/PlaybackHistory?Cursor=${encodeURIComponent(body.NextCursor!)}`),
    );
    const older = (await both.json()) as { Items: Array<{ Name: string }> };
    expect(older.Items).toHaveLength(1);
    expect(
      (await send(app, get("/Users/owner/PlaybackHistory?Cursor=abc&StartIndex=1"))).status,
    ).toBe(400);

    const removed = await send(
      app,
      new Request(`https://local.example/Users/owner/PlaybackHistory/${body.Items[0]!.Id}`, {
        method: "DELETE",
        headers: auth,
      }),
    );
    await expect(removed.json()).resolves.toEqual({ ok: true });
    const cleared = await send(
      app,
      new Request("https://local.example/Users/owner/PlaybackHistory/Clear", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ Before: "2026-09-25T00:00:00.000Z" }),
      }),
    );
    await expect(cleared.json()).resolves.toEqual({ ok: true, deleted: 1 });
  });

  it("lists seasons, episodes, and the next unplayed episode", async () => {
    const calls: Array<string> = [];
    const base = services();
    const episodes = [
      {
        ...media("episode-special"),
        userState: { ...state, canonicalId: "episode-special", played: false, positionTicks: 0 },
      },
      {
        ...media("episode-1"),
        userState: { ...state, canonicalId: "episode-1", played: false, positionTicks: 0 },
      },
      {
        ...media("episode-2"),
        userState: { ...state, canonicalId: "episode-2", played: false, positionTicks: 5 },
      },
    ];
    const app = makeEmbyHandler({
      ...base,
      federation: {
        ...base.federation,
        list: () =>
          Effect.succeed({
            ...emptyPage,
            items: [media("series-1")],
            totalRecordCount: 1,
          }),
        showChildren: (query) => {
          calls.push(`${query.kind}:${query.seasonNumber ?? ""}:${query.seasonId ?? ""}`);
          if (query.seriesId === "missing") return Effect.succeed(null);
          return Effect.succeed({
            ...emptyPage,
            items: query.kind === "Season" ? [media("season-1")] : episodes,
            totalRecordCount: 1,
          });
        },
      },
    });
    const seasons = await send(app, get("/Shows/series-1/Seasons"));
    await expect(seasons.json()).resolves.toMatchObject({ Items: [{ Id: "season-1" }] });
    const listed = await send(app, get("/emby/Shows/series-1/Episodes?Season=1&SeasonId=season-1"));
    expect(listed.status).toBe(200);
    expect(calls).toContain("Episode:1:season-1");
    expect((await send(app, get("/Shows/missing/Seasons"))).status).toBe(404);
    const next = await send(app, get("/Shows/NextUp?SeriesId=series-1"));
    const nextBody = (await next.json()) as { Items: Array<{ Id: string }> };
    expect(nextBody.Items.map(({ Id }) => Id)).toEqual(["episode-1"]);
  });

  it("accepts a connection password and manages it from the console", async () => {
    const app = makeEmbyHandler(services());
    const created = await send(
      app,
      new Request("https://local.example/api/me/emby-connections", {
        method: "POST",
        headers: { authorization: "Bearer console-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "phone", password: "secret1" }),
      }),
    );
    expect(created.status).toBe(200);
    const credential = (await created.json()) as { id: string; password: string };
    expect(credential.password).toBe("secret1");
    expect(
      (
        await send(
          app,
          new Request("https://local.example/api/me/emby-connections", {
            headers: auth,
          }),
        )
      ).status,
    ).toBe(401);

    const login = await send(
      app,
      new Request("https://local.example/Users/AuthenticateByName", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-emby-authorization":
            'MediaBrowser Client="SenPlayer", Device="iPhone", DeviceId="sen-device", Version="3"',
        },
        body: JSON.stringify({ Username: "owner", Password: "secret1" }),
      }),
    );
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({ AccessToken: "connection-token" });

    const listed = await send(
      app,
      get("/me/emby-connections", { authorization: "Bearer console-token" }),
    );
    const connections = (await listed.json()) as {
      credentials: Array<{ password?: string; devices: unknown[] }>;
    };
    expect(connections.credentials[0]?.password).toBeUndefined();
    expect(connections.credentials[0]?.devices).toHaveLength(1);

    const patched = await send(
      app,
      new Request(`https://local.example/emby/me/emby-connections/${credential.id}`, {
        method: "PATCH",
        headers: { authorization: "Bearer console-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const next = (await patched.json()) as { password: string };
    expect(next.password).toMatch(/^\d{6}$/);
    const deleted = await send(
      app,
      new Request(`https://local.example/api/me/emby-connections/${credential.id}`, {
        method: "DELETE",
        headers: { authorization: "Bearer console-token" },
      }),
    );
    await expect(deleted.json()).resolves.toEqual({ ok: true });
  });

  it("routes show, genre, and console prefixes into the Emby handler", async () => {
    const calls: Array<string> = [];
    const layer = Layer.succeed(
      ApplicationServices,
      ApplicationServices.of({
        handleDashboard: () => Effect.die("dashboard"),
        handleDashboardAsset: () => Effect.die("asset"),
        handleEmby: (request) =>
          Effect.sync(() => {
            calls.push(new URL(request.url).pathname);
            return new Response(null, { status: 204 });
          }),
      }),
    );
    for (const path of [
      "/Shows/series-1/Seasons",
      "/Genres",
      "/me/emby-connections",
      "/watch/history",
      "/api/me/emby-connections",
      "/api/watch/history",
    ]) {
      const response = await Effect.runPromise(
        routeApplication(new Request(`https://local.example${path}`)).pipe(Effect.provide(layer)),
      );
      expect(response.status, path).toBe(204);
    }
    expect(calls).toEqual([
      "/Shows/series-1/Seasons",
      "/Genres",
      "/me/emby-connections",
      "/watch/history",
      "/api/me/emby-connections",
      "/api/watch/history",
    ]);
  });
});
