import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DashboardApi,
  MetadataProviderSettingsInput,
  MetadataProviderSettingsView,
  PublicError,
  ServerInput,
  ServerView,
} from "../src/index.js";

const baseServer = {
  name: "Home",
  endpoints: [{ protocol: "https", host: "emby.example.com", port: null, path: "" }],
  username: "alice",
  password: { _tag: "Set" as const, value: "secret" },
  enabled: true,
};

describe("Dashboard contracts", () => {
  it("registers metadata settings under the system API group", () => {
    const endpoints = DashboardApi.groups.system.endpoints;
    expect(endpoints.getMetadataSettings.path).toBe("/api/dashboard/metadata-settings");
    expect(endpoints.updateMetadataSettings.path).toBe("/api/dashboard/metadata-settings");
  });

  it.each([
    ["http endpoint", { protocol: "http", host: "192.168.1.10", port: 8096, path: "/emby" }, true],
    ["https endpoint", { protocol: "https", host: "emby.example.com", port: null, path: "" }, true],
    ["Unicode IDN host", { protocol: "https", host: "例子.测试", port: null, path: "" }, true],
    [
      "expanded IPv6 host",
      { protocol: "https", host: "[2001:0db8:0:0:0:0:0:1]", port: null, path: "" },
      true,
    ],
    [
      "unsupported protocol",
      { protocol: "ftp", host: "emby.example.com", port: null, path: "" },
      false,
    ],
    ["port zero", { protocol: "https", host: "emby.example.com", port: 0, path: "" }, false],
    ["minimum port", { protocol: "https", host: "emby.example.com", port: 1, path: "" }, true],
    ["maximum port", { protocol: "https", host: "emby.example.com", port: 65535, path: "" }, true],
    [
      "port above range",
      { protocol: "https", host: "emby.example.com", port: 65536, path: "" },
      false,
    ],
    [
      "non-integer port",
      { protocol: "https", host: "emby.example.com", port: 8096.5, path: "" },
      false,
    ],
    [
      "host with userinfo",
      { protocol: "https", host: "alice:secret@emby.example.com", port: null, path: "" },
      false,
    ],
    [
      "path without leading slash",
      { protocol: "https", host: "emby.example.com", port: null, path: "emby" },
      false,
    ],
    [
      "path with query",
      { protocol: "https", host: "emby.example.com", port: null, path: "/emby?token=x" },
      false,
    ],
    [
      "path with fragment",
      { protocol: "https", host: "emby.example.com", port: null, path: "/emby#x" },
      false,
    ],
  ])("%s is %s", async (_name, endpoint, valid) => {
    const result = Schema.decodeUnknownPromise(ServerInput)({
      ...baseServer,
      endpoints: [endpoint],
      userAgentPolicy: "fixed",
      userAgent: "SenPlayer/3.2.1",
    });
    if (valid) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toBeDefined();
  });

  it("requires endpoints, canonical endpoint uniqueness, and valid User-Agent policies", async () => {
    const fixed = { userAgentPolicy: "fixed", userAgent: "SenPlayer/3.2.1" } as const;
    const preferred = { userAgentPolicy: "client-preferred", userAgent: null } as const;
    const passthrough = { userAgentPolicy: "passthrough", userAgent: null } as const;

    await expect(
      Schema.decodeUnknownPromise(ServerInput)({ ...baseServer, endpoints: [], ...fixed }),
    ).rejects.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(ServerInput)({ ...baseServer, ...fixed }),
    ).resolves.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(ServerInput)({ ...baseServer, ...preferred }),
    ).resolves.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(ServerInput)({ ...baseServer, ...passthrough }),
    ).resolves.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(ServerInput)({
        ...baseServer,
        userAgentPolicy: "fixed",
        userAgent: null,
      }),
    ).rejects.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(ServerInput)({
        ...baseServer,
        ...fixed,
        endpoints: [
          { protocol: "https", host: "emby.example.com", port: null, path: "" },
          { protocol: "https", host: "EMBY.EXAMPLE.COM", port: 443, path: "/" },
        ],
      }),
    ).rejects.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(ServerInput)({
        ...baseServer,
        ...fixed,
        endpoints: [
          { protocol: "https", host: "emby.example.com", port: null, path: "" },
          { protocol: "https", host: "emby.example.com", port: null, path: "/a/../" },
        ],
      }),
    ).rejects.toBeDefined();
  });

  it("accepts write-only credentials but never returns them", async () => {
    const view = await Schema.decodeUnknownPromise(ServerView)({
      id: "server-1",
      name: "Home",
      endpoints: [
        {
          id: "endpoint-1",
          protocol: "https",
          host: "emby.example.com",
          port: null,
          path: "",
          displayUrl: "https://emby.example.com",
          verifiedCatalogId: null,
          health: "unknown",
          lastSuccessAtMs: null,
        },
      ],
      username: "alice",
      hasPassword: true,
      userAgentPolicy: "fixed",
      userAgent: "SenPlayer/3.2.1",
      enabled: true,
      verifiedCatalogId: null,
      generation: 1,
      health: "unknown",
    });
    expect(view).not.toHaveProperty("password");
    expect(view).not.toHaveProperty("accessToken");
  });

  it("requires exactly one ordered TMDB and Trakt setting and redacts credentials from views", async () => {
    const settings = {
      providers: [
        {
          id: "tmdb",
          enabled: true,
          order: 0,
          language: "zh-CN",
          credential: { _tag: "Set" as const, value: "secret" },
        },
        {
          id: "trakt",
          enabled: false,
          order: 1,
          language: null,
          credential: { _tag: "Preserve" as const },
        },
      ],
    };
    await expect(
      Schema.decodeUnknownPromise(MetadataProviderSettingsInput)(settings),
    ).resolves.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(MetadataProviderSettingsInput)({
        providers: [settings.providers[0], { ...settings.providers[0], order: 1 }],
      }),
    ).rejects.toBeDefined();

    const view = await Schema.encodeUnknownPromise(MetadataProviderSettingsView)({
      providers: [
        {
          id: "trakt",
          enabled: true,
          order: 0,
          language: null,
          hasCredential: true,
          status: "ready",
        },
        {
          id: "tmdb",
          enabled: false,
          order: 1,
          language: "zh-CN",
          hasCredential: false,
          status: "unconfigured",
        },
      ],
    });
    expect(view.providers).toEqual([
      {
        id: "trakt",
        enabled: true,
        order: 0,
        language: null,
        hasCredential: true,
        status: "ready",
      },
      {
        id: "tmdb",
        enabled: false,
        order: 1,
        language: "zh-CN",
        hasCredential: false,
        status: "unconfigured",
      },
    ]);
    expect(view.providers[0]).not.toHaveProperty("credential");
  });

  it("keeps an upstream rejection diagnostic in the public contract", async () => {
    const error = await Schema.decodeUnknownPromise(PublicError)({
      _tag: "UpstreamRejected",
      serverId: "server-1",
      status: 401,
      detail: "Invalid username or password",
    });

    expect(error).toEqual({
      _tag: "UpstreamRejected",
      serverId: "server-1",
      status: 401,
      detail: "Invalid username or password",
    });
  });

  it("keeps an upstream unavailability diagnostic in the public contract", async () => {
    const error = await Schema.decodeUnknownPromise(PublicError)({
      _tag: "UpstreamUnavailable",
      serverId: "server-1",
      detail: "connection refused",
    });

    expect(error).toEqual({
      _tag: "UpstreamUnavailable",
      serverId: "server-1",
      detail: "connection refused",
    });
  });
});
