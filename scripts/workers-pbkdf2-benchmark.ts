import { PBKDF2_ITERATIONS } from "../apps/server/src/core/limits.js"
import { derivePbkdf2 } from "./pbkdf2-benchmark.js"

interface BenchmarkEnv {
  readonly BENCHMARK_TOKEN?: string
  readonly BENCHMARK_COMPATIBILITY_DATE?: string
}

const encoder = new TextEncoder()

const sameToken = async (actual: string, expected: string): Promise<boolean> => {
  const [actualDigest, expectedDigest] = await Promise.all([actual, expected].map(async (value) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))))
  let difference = 0
  for (let index = 0; index < expectedDigest.length; index++) {
    difference |= actualDigest[index]! ^ expectedDigest[index]!
  }
  return difference === 0
}

export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/__pbkdf2" || url.search || url.hash) {
      return new Response(null, { status: 404 })
    }
    const authorization = request.headers.get("authorization") ?? ""
    if (!env.BENCHMARK_TOKEN || !/^\d{4}-\d{2}-\d{2}$/.test(env.BENCHMARK_COMPATIBILITY_DATE ?? "") ||
      !(await sameToken(authorization, `Bearer ${env.BENCHMARK_TOKEN}`))) {
      return new Response(null, { status: 404 })
    }
    await derivePbkdf2()
    return Response.json({
      runtime: "Cloudflare Workers",
      compatibilityDate: env.BENCHMARK_COMPATIBILITY_DATE,
      iterations: PBKDF2_ITERATIONS,
      derivations: 1
    }, {
      headers: { "cache-control": "private, no-store" }
    })
  }
} satisfies ExportedHandler<BenchmarkEnv>
