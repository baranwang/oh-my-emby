import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ServerInput, ServerView } from "../src/index.js"

describe("Dashboard contracts", () => {
  it("accepts write-only credentials but never returns them", async () => {
    const input = await Schema.decodeUnknownPromise(ServerInput)({
      name: "Home",
      baseUrl: "https://emby.example.com",
      username: "alice",
      password: { _tag: "Set", value: "secret" },
      userAgent: "SenPlayer/1",
      enabled: true
    })
    expect(input.password._tag).toBe("Set")

    const view = await Schema.decodeUnknownPromise(ServerView)({
      id: "server-1",
      name: "Home",
      baseUrl: "https://emby.example.com",
      username: "alice",
      hasPassword: true,
      userAgent: "SenPlayer/1",
      enabled: true,
      verifiedCatalogId: null,
      generation: 1,
      health: "unknown"
    })
    expect(view).not.toHaveProperty("password")
    expect(view).not.toHaveProperty("accessToken")
  })

  it("rejects non-HTTP upstream URLs", async () => {
    await expect(Schema.decodeUnknownPromise(ServerInput)({
      name: "Home",
      baseUrl: "ftp://emby.example.com",
      username: "alice",
      password: { _tag: "Preserve" },
      userAgent: "SenPlayer/1",
      enabled: true
    })).rejects.toBeDefined()
  })

  it.each([
    "https://alice:secret@emby.example.com",
    "https://emby.example.com/?api_key=secret",
    "https://emby.example.com/#secret"
  ])("rejects secret-bearing upstream URL %s", async (baseUrl) => {
    await expect(Schema.decodeUnknownPromise(ServerInput)({
      name: "Home",
      baseUrl,
      username: "alice",
      password: { _tag: "Preserve" },
      userAgent: "SenPlayer/1",
      enabled: true
    })).rejects.toBeDefined()
  })
})
