import { PBKDF2_ITERATIONS } from "../apps/server/src/core/limits.js"

const encoder = new TextEncoder()
const password = encoder.encode("oh-my-emby-benchmark-password")
const salt = encoder.encode("fixed-salt-16byt")
const durations: Array<number> = []

for (let run = 0; run < 10; run++) {
  const startedAt = performance.now()
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"])
  await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations: PBKDF2_ITERATIONS
  }, key, 256)
  durations.push(performance.now() - startedAt)
}

const samples = durations.slice(1).sort((left, right) => left - right)
const percentile = (value: number) => samples[Math.ceil(samples.length * value) - 1]!
const p50Ms = percentile(0.5)
const p95Ms = percentile(0.95)

console.log(JSON.stringify({
  runtime: `Bun ${Bun.version}`,
  iterations: PBKDF2_ITERATIONS,
  runs: durations.length,
  warmupRunsDiscarded: 1,
  p50Ms: Number(p50Ms.toFixed(2)),
  p95Ms: Number(p95Ms.toFixed(2)),
  gateMs: 250,
  passed: p95Ms < 250
}, null, 2))

if (p95Ms >= 250) process.exitCode = 1
