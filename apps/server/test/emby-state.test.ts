import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js"
import { RepositoryError } from "../src/core/errors.js"
import type { PlaybackEvent, UserStatePatch, UserStateRecord } from "../src/core/model.js"

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "sen-device",
  deviceName: "SenPlayer"
}

const state = (canonicalId: string, patch: UserStatePatch = {}): UserStateRecord => ({
  canonicalId,
  revision: 1,
  played: patch.played ?? false,
  favorite: patch.favorite ?? false,
  playCount: patch.playCount ?? 0,
  positionTicks: patch.positionTicks ?? 0,
  lastPlayedVersionId: patch.lastPlayedVersionId ?? null,
  updatedAtMs: 5_000
})

const services = (
  write: (canonicalId: string, patch: UserStatePatch) => Effect.Effect<UserStateRecord, any>,
  record: (event: PlaybackEvent) => Effect.Effect<UserStateRecord | null, any>
): EmbyServices => ({
  config: { serverId: "virtual-server", serverName: "Oh My Emby", version: "0.0.0" },
  now: () => 5_000,
  auth: {
    loginEmby: () => Effect.die("unused"),
    authenticateEmby: () => Effect.succeed(principal)
  },
  federation: {
    list: () => Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    search: () => Effect.succeed({ items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: [] }),
    detail: (id) => Effect.succeed({
      id,
      itemType: "Movie",
      displayMetadata: { RunTimeTicks: 321 },
      mediaVersions: [],
      userState: null,
      incompleteSourceIds: []
    })
  },
  userState: { write, recordPlaybackEvent: record },
  libraries: { list: () => Effect.succeed([]) },
  playback: { getInfo: () => Effect.die("unused") }
})

const request = (path: string, method: string, body?: unknown) => new Request(`https://local${path}`, {
  method,
  headers: {
    authorization: "Bearer token",
    ...(body === undefined ? {} : { "content-type": "application/json" })
  },
  body: body === undefined ? undefined : JSON.stringify(body)
})

describe("Emby local state and playback reports", () => {
  it.each([
    ["POST", "/Users/owner/FavoriteItems/movie-1", { favorite: true }],
    ["DELETE", "/emby/Users/owner/FavoriteItems/movie-1", { favorite: false }],
    ["POST", "/Users/owner/PlayedItems/movie-1", { played: true, positionTicks: 0 }],
    ["DELETE", "/emby/Users/owner/PlayedItems/movie-1", {
      played: false,
      playCount: 0,
      positionTicks: 0
    }]
  ] as const)("applies %s %s locally", async (method, path, expected) => {
    const writes: Array<{ id: string; patch: UserStatePatch }> = []
    const app = makeEmbyHandler(services((id, patch) => {
      writes.push({ id, patch })
      return Effect.succeed(state(id, patch))
    }, () => Effect.die("unused")))

    const response = await Effect.runPromise(app(request(path, method)))

    expect(response.status).toBe(200)
    expect(writes).toEqual([{ id: "movie-1", patch: expected }])
    await expect(response.json()).resolves.toMatchObject({ ItemId: "movie-1" })
  })

  it("accepts an absolute local UserData patch for resume and watched state", async () => {
    let observed: UserStatePatch | undefined
    const app = makeEmbyHandler(services((id, patch) => {
      observed = patch
      return Effect.succeed(state(id, patch))
    }, () => Effect.die("unused")))
    const response = await Effect.runPromise(app(request(
      "/Users/owner/Items/movie-1/UserData",
      "POST",
      {
        Played: false,
        IsFavorite: true,
        PlayCount: 4,
        PlaybackPositionTicks: 123,
        LastPlayedVersionId: "version-a"
      }
    )))

    expect(response.status).toBe(200)
    expect(observed).toEqual({
      played: false,
      favorite: true,
      playCount: 4,
      positionTicks: 123,
      lastPlayedVersionId: "version-a"
    })
  })

  it.each([
    ["/Sessions/Playing", "start", false],
    ["/emby/Sessions/Playing/Progress", "progress", false],
    ["/Sessions/Playing/Stopped", "stop", true]
  ] as const)("records %s as %s", async (path, kind, completed) => {
    const events: Array<PlaybackEvent> = []
    const app = makeEmbyHandler(services(
      () => Effect.die("unused"),
      (event) => {
        events.push(event)
        return Effect.succeed(state(event.canonicalId, { positionTicks: event.positionTicks }))
      }
    ))
    const response = await Effect.runPromise(app(request(path, "POST", {
      ItemId: "movie-1",
      MediaSourceId: "version-a",
      PlaySessionId: "session-a",
      PositionTicks: completed ? 321 : 123
    })))

    expect(response.status).toBe(204)
    expect(events).toEqual([{
      kind,
      localSessionId: "session-a",
      canonicalId: "movie-1",
      versionId: "version-a",
      positionTicks: completed ? 321 : 123,
      occurredAtMs: 5_000,
      ...(kind === "stop" ? { played: true } : {})
    }])
  })

  it("defaults an omitted optional playback position to zero", async () => {
    const events: Array<PlaybackEvent> = []
    const app = makeEmbyHandler(services(
      () => Effect.die("unused"),
      (event) => {
        events.push(event)
        return Effect.succeed(null)
      }
    ))
    const response = await Effect.runPromise(app(request("/Sessions/Playing", "POST", {
      ItemId: "movie-1",
      MediaSourceId: "version-a",
      PlaySessionId: "session-a"
    })))

    expect(response.status).toBe(204)
    expect(events[0]?.positionTicks).toBe(0)
  })

  it("validates state bodies before UserState calls", async () => {
    let calls = 0
    const app = makeEmbyHandler(services(
      () => {
        calls++
        return Effect.die("not reached")
      },
      () => {
        calls++
        return Effect.die("not reached")
      }
    ))
    const emptyPatch = await Effect.runPromise(app(request(
      "/Users/owner/Items/movie-1/UserData",
      "POST",
      {}
    )))
    const invalidPlayback = await Effect.runPromise(app(request(
      "/Sessions/Playing",
      "POST",
      { ItemId: "movie-1", PositionTicks: -1 }
    )))

    expect(emptyPatch.status).toBe(400)
    expect(invalidPlayback.status).toBe(400)
    expect(calls).toBe(0)
  })

  it("redacts state persistence failures", async () => {
    const app = makeEmbyHandler(services(
      () => Effect.fail(new RepositoryError({
        operation: "writeUserState",
        message: "token=private-token"
      })),
      () => Effect.die("unused")
    ))
    const response = await Effect.runPromise(app(request(
      "/Users/owner/FavoriteItems/movie-1",
      "POST"
    )))
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).not.toContain("private-token")
  })

  it("interrupts an in-flight core call when the native request is aborted", async () => {
    let started = false
    let cancelled = false
    const controller = new AbortController()
    const app = makeEmbyHandler({
      ...services(() => Effect.die("unused"), () => Effect.die("unused")),
      federation: {
        list: () => Effect.callback((resume) => {
          started = true
          const timer = setTimeout(() => resume(Effect.succeed({
            items: [], totalRecordCount: 0, exhausted: true, incompleteSourceIds: []
          })), 5_000)
          return Effect.sync(() => {
            clearTimeout(timer)
            cancelled = true
          })
        }),
        search: () => Effect.die("unused"),
        detail: () => Effect.die("unused")
      }
    })
    const running = Effect.runPromise(app(new Request(
      "https://local/Users/owner/Items?ParentId=library-1",
      { headers: { authorization: "Bearer token" }, signal: controller.signal }
    )))
    while (!started) await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    await expect(running).rejects.toBeDefined()
    expect(cancelled).toBe(true)
  })
})
