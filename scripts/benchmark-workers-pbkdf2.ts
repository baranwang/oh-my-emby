import { summarizePbkdf2Benchmark } from "./pbkdf2-benchmark.js"
import { PBKDF2_ITERATIONS } from "../apps/server/src/core/limits.js"

const originValue = Bun.env.WORKERS_BENCHMARK_ORIGIN ?? ""
const token = Bun.env.WORKERS_BENCHMARK_TOKEN ?? ""
const origin = new URL(originValue)
const loopback = origin.protocol === "http:" && origin.hostname === "127.0.0.1"
if ((!loopback && origin.protocol !== "https:") || origin.origin !== originValue || !token) {
  throw new Error("Workers benchmark requires an exact HTTPS origin and ephemeral token")
}

const durations: Array<number> = []
let compatibilityDate: string | undefined
for (let run = 0; run < 10; run++) {
  const startedAt = performance.now()
  const response = await fetch(`${origin.origin}/__pbkdf2`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000)
  })
  const receipt = await response.json() as Record<string, unknown>
  durations.push(performance.now() - startedAt)
  const receivedCompatibilityDate = receipt.compatibilityDate
  if (!response.ok || response.headers.get("cache-control") !== "private, no-store" ||
    receipt.runtime !== "Cloudflare Workers" || receipt.iterations !== PBKDF2_ITERATIONS ||
    receipt.derivations !== 1 || typeof receivedCompatibilityDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(receivedCompatibilityDate) ||
    (compatibilityDate !== undefined && compatibilityDate !== receivedCompatibilityDate)) {
    throw new Error("Workers benchmark returned an invalid derivation receipt")
  }
  compatibilityDate = receivedCompatibilityDate
}

if (compatibilityDate === undefined) throw new Error("Workers benchmark returned no samples")
const result = {
  ...summarizePbkdf2Benchmark("Cloudflare Workers", "remote-request-upper-bound", durations),
  compatibilityDate
}
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
