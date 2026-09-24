import { Effect, Layer } from "effect"
import { configure, reset, type LogRecord } from "@logtape/logtape"
import { describe, expect, it } from "vitest"

import {
  makeEmbyHandler,
  type EmbyServices
} from "../src/api/emby.js"
import {
  ApplicationServices,
  isDashboardNavigationRequest,
  routeApplication
} from "../src/api/application.js"
import { RepositoryError } from "../src/core/errors.js"

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "sen-device",
  deviceName: "SenPlayer"
}

const services = (overrides: Partial<EmbyServices> = {}): EmbyServices => ({
  config: { serverId: "virtual-server", serverName: "Oh My Emby", version: "0.0.0" },
  now: () => 1_234,
  auth: {
    loginEmby: () => Effect.succeed({
      accessToken: "local-token",
      userId: "owner",
      expiresAtMs: Number.MAX_SAFE_INTEGER
    }),
    authenticateEmby: () => Effect.succeed(principal)
  },
  federation: {
    list: () => Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    search: () => Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    detail: () => Effect.succeed(null),
    lookupMembership: () => Effect.succeed(null)
  },
  userState: {
    write: () => Effect.die("unused"),
    recordPlaybackEvent: () => Effect.die("unused")
  },
  libraries: { list: () => Effect.succeed([]) },
  playback: { getInfo: () => Effect.die("unused") },
  ...overrides
})

const authorization =
  "MediaBrowser Client=\"SenPlayer\", Device=\"iPhone\", DeviceId=\"sen-device\", Version=\"3.0\""

const json = (path: string, body: unknown, headers: HeadersInit = {}) => new Request(`https://local${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body)
})

describe("Emby authentication and application routing", () => {
  it("audits useful Emby query values while redacting credentials and search terms", async () => {
    const records: Array<LogRecord> = []
    await configure({
      reset: true,
      sinks: { capture: (record) => records.push(record) },
      loggers: [{ category: ["oh-my-emby"], sinks: ["capture"], lowestLevel: "info" }]
    })
    try {
      const response = await Effect.runPromise(makeEmbyHandler(services())(new Request(
        "https://local/Users/owner/Items?ParentId=library-1&MediaSourceId=version-a&Static=true" +
          "&SearchTerm=confidential&api_key=private-key&X-Emby-Token=another-secret",
        {
          headers: {
            authorization: "Bearer very-secret-token",
            "user-agent": "SenPlayer/3.0 (macOS)"
          }
        }
      )))

      expect(response.status).toBe(200)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        category: ["oh-my-emby", "emby"],
        level: "info",
        properties: {
          method: "GET",
          path: "/Users/owner/Items",
          status: 200,
          userAgent: "SenPlayer/3.0 (macOS)",
          queryKeys: ["MediaSourceId", "ParentId", "SearchTerm", "Static"],
          query: {
            ParentId: ["library-1"],
            MediaSourceId: ["version-a"],
            Static: ["true"],
            SearchTerm: ["[redacted]"],
            api_key: ["[redacted]"],
            "X-Emby-Token": ["[redacted]"]
          },
          hasParentId: true,
          hasSensitiveQuery: true
        }
      })
      expect(String(records[0]!.rawMessage)).toContain("{queryKeys}")
      expect(String(records[0]!.rawMessage)).toContain("{query}")
      expect(String(records[0]!.rawMessage)).toContain("{userAgent}")
      expect(String(records[0]!.rawMessage)).toContain("{hasParentId}")
      expect(JSON.stringify(records[0])).not.toContain("private-key")
      expect(JSON.stringify(records[0])).not.toContain("another-secret")
      expect(JSON.stringify(records[0])).not.toContain("very-secret-token")
      expect(JSON.stringify(records[0])).not.toContain("confidential")
    } finally {
      await reset()
    }
  })

  it("audits a stream redirect target without exposing its token", async () => {
    const records: Array<LogRecord> = []
    await configure({
      reset: true,
      sinks: { capture: (record) => records.push(record) },
      loggers: [{ category: ["oh-my-emby"], sinks: ["capture"], lowestLevel: "info" }]
    })
    try {
      const response = await Effect.runPromise(makeEmbyHandler(services({
        playback: {
          getInfo: () => Effect.die("unused"),
          resolveVideoRedirect: () => Effect.succeed(new URL(
            "https://upstream.example/emby/Videos/remote-1/stream?Static=true&api_key=upstream-secret"
          ))
        }
      }))(new Request(
        "https://local/Videos/canonical-1/stream?MediaSourceId=version-a&X-Emby-Token=local-secret",
        { headers: { authorization: "Bearer local-token" } }
      )))

      expect(response.status).toBe(302)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        properties: {
          redirect: {
            protocol: "https:",
            origin: "https://upstream.example",
            path: "/emby/Videos/remote-1/stream",
            queryKeys: ["Static"],
            query: {
              Static: ["true"],
              api_key: ["[redacted]"]
            },
            hasSensitiveQuery: true
          }
        }
      })
      expect(JSON.stringify(records[0])).not.toContain("upstream-secret")
      expect(JSON.stringify(records[0])).not.toContain("local-secret")
    } finally {
      await reset()
    }
  })

  it.each(["/System/Info/Public", "/emby/System/Info/Public"])(
    "returns the same public identity for %s",
    async (path) => {
      const response = await Effect.runPromise(makeEmbyHandler(services())(new Request(`https://local${path}`)))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        Id: "virtual-server",
        ServerName: "Oh My Emby",
        ProductName: "oh-my-emby",
        Version: "0.0.0",
        StartupWizardCompleted: true
      })
    }
  )

  it("returns default display preferences for an authenticated Emby user", async () => {
    const response = await Effect.runPromise(makeEmbyHandler(services())(new Request(
      "https://local/DisplayPreferences/usersettings?userId=owner&client=emby",
      { headers: { authorization: "Bearer token" } }
    )))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      Id: "usersettings",
      Client: "emby",
      RememberIndexing: false,
      PrimaryImageHeight: 250,
      PrimaryImageWidth: 250,
      CustomPrefs: {},
      ScrollDirection: "Horizontal",
      ShowBackdrop: true,
      RememberSorting: false,
      SortOrder: "Ascending",
      ShowSidebar: false
    })
  })

  it("returns the authenticated user profile for Infuse's post-login check", async () => {
    const response = await Effect.runPromise(makeEmbyHandler(services())(new Request(
      "https://local/Users/owner",
      { headers: { authorization: "Bearer token" } }
    )))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      Id: "owner",
      Name: "owner",
      ServerId: "virtual-server",
      HasPassword: true,
      HasConfiguredPassword: true
    })
  })

  it.each(["/Users/AuthenticateByName", "/emby/Users/AuthenticateByName"])(
    "authenticates a SenPlayer login at %s",
    async (path) => {
      let input: unknown
      let scopeKey = ""
      const app = makeEmbyHandler(services({
        auth: {
          loginEmby: (value, options) => {
            input = value
            scopeKey = options.scopeKey
            return Effect.succeed({
              accessToken: "local-token",
              userId: "owner",
              expiresAtMs: Number.MAX_SAFE_INTEGER
            })
          },
          authenticateEmby: () => Effect.succeed(principal)
        }
      }))
      const response = await Effect.runPromise(app(json(path, {
        Username: "owner",
        Pw: "correct horse battery staple"
      }, { "x-emby-authorization": authorization })))

      expect(response.status).toBe(200)
      expect(input).toMatchObject({
        username: "owner",
        password: "correct horse battery staple",
        deviceId: "sen-device",
        deviceName: "iPhone"
      })
      expect(scopeKey).toBe("emby:owner")
      await expect(response.json()).resolves.toMatchObject({
        AccessToken: "local-token",
        ServerId: "virtual-server",
        User: { Id: "owner", Name: "owner", ServerId: "virtual-server" }
      })
    }
  )

  it("accepts bearer and X-Emby-Token authentication", async () => {
    const observed: Array<string> = []
    const app = makeEmbyHandler(services({
      auth: {
        loginEmby: () => Effect.die("unused"),
        authenticateEmby: (token) => {
          observed.push(token)
          return Effect.succeed(principal)
        }
      }
    }))

    for (const headers of [
      { authorization: "Bearer bearer-token" },
      { "x-emby-token": "emby-token" }
    ]) {
      const response = await Effect.runPromise(app(new Request("https://local/System/Info", { headers })))
      expect(response.status).toBe(200)
    }
    expect(observed).toEqual(["bearer-token", "emby-token"])
  })

  it("validates login metadata and body before Auth is called", async () => {
    let calls = 0
    const app = makeEmbyHandler(services({
      auth: {
        loginEmby: () => {
          calls++
          return Effect.die("not reached")
        },
        authenticateEmby: () => Effect.succeed(principal)
      }
    }))
    const response = await Effect.runPromise(app(json("/Users/AuthenticateByName", {
      Username: "",
      Pw: "secret"
    })))

    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  it("maps typed failures without exposing internal messages", async () => {
    const app = makeEmbyHandler(services({
      auth: {
        loginEmby: () => Effect.fail(new RepositoryError({
          operation: "login",
          message: "database password=super-secret"
        })),
        authenticateEmby: () => Effect.succeed(principal)
      }
    }))
    const response = await Effect.runPromise(app(json("/Users/AuthenticateByName", {
      Username: "owner",
      Pw: "secret"
    }, { "x-emby-authorization": authorization })))
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(text).not.toContain("super-secret")
    expect(text).not.toContain("password=")
  })

  it("routes dashboard API before Emby, exposes a minimal health body, and never SPA-falls back APIs", async () => {
    const calls: Array<string> = []
    const layer = Layer.succeed(ApplicationServices, ApplicationServices.of({
      handleDashboard: (request) => {
        calls.push(`dashboard:${new URL(request.url).pathname}`)
        return Effect.succeed(Response.json({ error: "missing" }, { status: 404 }))
      },
      handleEmby: (request) => {
        calls.push(`emby:${new URL(request.url).pathname}`)
        return Effect.succeed(Response.json({ error: "missing" }, { status: 404 }))
      },
      handleDashboardAsset: (request) => {
        calls.push(`asset:${new URL(request.url).pathname}`)
        return Effect.succeed(new Response("<html>dashboard</html>", {
          headers: { "content-type": "text/html" }
        }))
      }
    }))
    const request = (path: string) => Effect.runPromise(routeApplication(new Request(`https://local${path}`, {
      headers: { accept: "text/html" }
    })).pipe(Effect.provide(layer)))

    const dashboard = await request("/api/dashboard/emby/System/Info")
    const emby = await request("/emby/Not/A/Route")
    const virtualFolders = await request("/Library/VirtualFolders")
    const displayPreferences = await request("/DisplayPreferences/usersettings?userId=owner&client=emby")
    const unknownApi = await request("/api/not-dashboard")
    const asset = await request("/dashboard/app.js")
    const health = await request("/health")

    expect(calls).toEqual([
      "dashboard:/api/dashboard/emby/System/Info",
      "emby:/emby/Not/A/Route",
      "emby:/Library/VirtualFolders",
      "emby:/DisplayPreferences/usersettings",
      "asset:/dashboard/app.js"
    ])
    expect(dashboard.headers.get("content-type")).toContain("application/json")
    expect(emby.headers.get("content-type")).toContain("application/json")
    expect(virtualFolders.headers.get("content-type")).toContain("application/json")
    expect(displayPreferences.headers.get("content-type")).toContain("application/json")
    expect(unknownApi.status).toBe(404)
    expect(unknownApi.headers.get("content-type")).toContain("application/json")
    expect(asset.headers.get("content-type")).toContain("text/html")
    const healthBody = await health.json() as Record<string, unknown>
    expect(healthBody).toEqual({ status: "ok" })
    expect(JSON.stringify(healthBody)).not.toMatch(/database|upstream|user|token|config/i)
  })

  it("recognizes only safe Dashboard navigation fallbacks", () => {
    expect(isDashboardNavigationRequest(new Request("https://local/dashboard/servers", {
      headers: { accept: "text/html" }
    }))).toBe(true)
    expect(isDashboardNavigationRequest(new Request("https://local/dashboard/app.js", {
      headers: { accept: "text/html" }
    }))).toBe(false)
    expect(isDashboardNavigationRequest(new Request("https://local/dashboard/servers", {
      method: "POST",
      headers: { accept: "text/html" }
    }))).toBe(false)
  })
})
