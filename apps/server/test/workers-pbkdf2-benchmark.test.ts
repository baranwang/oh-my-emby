import { describe, expect, it } from "vitest"

import { PBKDF2_ITERATIONS } from "../src/core/limits.js"
import benchmarkWorker from "../../../scripts/workers-pbkdf2-benchmark.js"

describe("Workers PBKDF2 benchmark entrypoint", () => {
  it("requires the ephemeral token and performs one untimed derivation", async () => {
    const env = {
      BENCHMARK_TOKEN: "ephemeral-token",
      BENCHMARK_COMPATIBILITY_DATE: "2026-09-20"
    }
    const unauthorized = await benchmarkWorker.fetch(new Request("https://benchmark.example/__pbkdf2", {
      method: "POST"
    }), env)
    expect(unauthorized.status).toBe(404)
    const missingSecret = await benchmarkWorker.fetch(new Request("https://benchmark.example/__pbkdf2", {
      method: "POST",
      headers: { authorization: "Bearer undefined" }
    }), { BENCHMARK_TOKEN: undefined, BENCHMARK_COMPATIBILITY_DATE: "2026-09-20" })
    expect(missingSecret.status).toBe(404)

    const response = await benchmarkWorker.fetch(new Request("https://benchmark.example/__pbkdf2", {
      method: "POST",
      headers: { authorization: "Bearer ephemeral-token" }
    }), env)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const result = await response.json() as Record<string, unknown>
    expect(result).toEqual({
      runtime: "Cloudflare Workers",
      compatibilityDate: "2026-09-20",
      iterations: PBKDF2_ITERATIONS,
      derivations: 1
    })
  })
})
