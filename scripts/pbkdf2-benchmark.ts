import { PBKDF2_ITERATIONS } from "../apps/server/src/core/limits.js"

export interface Pbkdf2BenchmarkResult {
  readonly runtime: string
  readonly measurement: "in-process" | "remote-request-upper-bound"
  readonly iterations: number
  readonly runs: number
  readonly warmupRunsDiscarded: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly gateMs: number
  readonly passed: boolean
}

const percentile = (samples: ReadonlyArray<number>, value: number) =>
  samples[Math.ceil(samples.length * value) - 1]!

export const derivePbkdf2 = async (): Promise<void> => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("oh-my-emby-benchmark-password"),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: encoder.encode("fixed-salt-16byt"),
    iterations: PBKDF2_ITERATIONS
  }, key, 256)
}

export const summarizePbkdf2Benchmark = (
  runtime: string,
  measurement: Pbkdf2BenchmarkResult["measurement"],
  durations: ReadonlyArray<number>
): Pbkdf2BenchmarkResult => {
  if (durations.length !== 10) throw new Error("PBKDF2 benchmark requires exactly 10 samples")
  const samples = durations.slice(1).sort((left, right) => left - right)
  const p50Ms = percentile(samples, 0.5)
  const p95Ms = percentile(samples, 0.95)
  const validTiming = samples.every((sample) => Number.isFinite(sample) && sample > 0)
  return {
    runtime,
    measurement,
    iterations: PBKDF2_ITERATIONS,
    runs: durations.length,
    warmupRunsDiscarded: 1,
    p50Ms: Number(p50Ms.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    gateMs: 250,
    passed: validTiming && p95Ms < 250
  }
}

export const runPbkdf2Benchmark = async (runtime: string): Promise<Pbkdf2BenchmarkResult> => {
  const durations: Array<number> = []

  for (let run = 0; run < 10; run++) {
    const startedAt = performance.now()
    await derivePbkdf2()
    durations.push(performance.now() - startedAt)
  }

  return summarizePbkdf2Benchmark(runtime, "in-process", durations)
}
