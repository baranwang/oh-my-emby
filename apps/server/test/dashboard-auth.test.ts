import { Effect } from "effect"
import * as Cookies from "effect/unstable/http/Cookies"
import { describe, expect, it } from "vitest"

import {
  dashboardSessionResponse,
  guardDashboardRequest,
  makeDashboardRequestPolicy
} from "../src/api/dashboard.js"

describe("Dashboard authentication boundary", () => {
  it("sets the opaque session cookie with all required flags", () => {
    const response = dashboardSessionResponse({
      token: "opaque-token",
      expiresAtMs: Date.UTC(2030, 0, 1),
      view: { authenticated: true, username: "owner" }
    })
    expect(Cookies.toSetCookieHeaders(response.cookies)).toEqual([
      expect.stringContaining("oh_my_emby_session=opaque-token")
    ])
    const header = Cookies.toSetCookieHeaders(response.cookies)[0]!
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Secure")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain("Path=/dashboard")
    expect(response.body._tag).toBe("Uint8Array")
    expect(JSON.stringify(response.body)).not.toContain("opaque-token")
  })

  it("rejects a mutation from any origin except the exact configured origin", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: []
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "https://dashboard.example.com/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: { origin: "https://evil.example.com" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("allows explicit localhost HTTP development", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "http://localhost:3000",
      trustedProxyAddresses: []
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://localhost:3000/api/dashboard/login",
      remoteAddress: "127.0.0.1",
      headers: { origin: "http://localhost:3000" }
    }))).resolves.toMatchObject({ clientKey: "127.0.0.1" })
  })

  it("rejects localhost HTTP requests arriving from a non-loopback client", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "http://localhost:3000",
      trustedProxyAddresses: []
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://localhost:3000/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: { origin: "http://localhost:3000" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("accepts proxy transport headers only from an explicit trusted address", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: ["10.0.0.2"]
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://internal:3000/api/dashboard/login",
      remoteAddress: "10.0.0.2",
      headers: {
        origin: "https://dashboard.example.com",
        "x-forwarded-for": "198.51.100.9, 10.0.0.2",
        "x-forwarded-host": "dashboard.example.com",
        "x-forwarded-proto": "https"
      }
    }))).resolves.toEqual({ clientKey: "198.51.100.9" })
  })

  it("never lets arbitrary forwarded headers grant transport trust", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: ["10.0.0.2"]
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://internal:3000/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: {
        origin: "https://dashboard.example.com",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "dashboard.example.com",
        "x-forwarded-proto": "https"
      }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("rejects non-localhost HTTP public origins at configuration time", () => {
    expect(() => makeDashboardRequestPolicy({
      publicOrigin: "http://dashboard.example.com",
      trustedProxyAddresses: []
    })).toThrow("public origin")
  })
})
