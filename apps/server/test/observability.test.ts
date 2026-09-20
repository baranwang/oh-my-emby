import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeObservability } from "../src/core/observability.js"

describe("upstream observability", () => {
  it("emits only the structured allowlist and never serializes secrets", async () => {
    const records: Array<string> = []
    const observability = makeObservability((record) => records.push(JSON.stringify(record)))
    await Effect.runPromise(observability.upstreamRequest({
      requestId: "request-1",
      route: "/api/dashboard/servers/:id/test",
      serverId: "server-1",
      durationMs: 25,
      cacheOutcome: "miss",
      retryOutcome: "retried",
      failureCategory: "timeout",
      password: "secret-password",
      token: "secret-token",
      authorization: "Bearer secret-token",
      requestBody: { password: "secret-password" },
      rawUpstreamBody: "secret response",
      url: "https://example.com/video?api_key=secret-token"
    } as any))

    expect(records).toHaveLength(1)
    const parsed = JSON.parse(records[0]!)
    expect(parsed).toEqual({
      requestId: "request-1",
      route: "/api/dashboard/servers/:id/test",
      serverId: "server-1",
      durationMs: 25,
      cacheOutcome: "miss",
      retryOutcome: "retried",
      failureCategory: "timeout"
    })
    const serialized = records[0]!
    for (const forbidden of [
      "password", "token", "authorization", "requestBody", "rawUpstreamBody", "url",
      "secret-password", "secret-token", "secret response", "api_key"
    ]) expect(serialized).not.toContain(forbidden)
  })
})
