interface OwnershipEnv {
  readonly SMOKE_RUN_ID?: string
  readonly SMOKE_OWNERSHIP_TOKEN?: string
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
  async fetch(request: Request, env: OwnershipEnv): Promise<Response> {
    const url = new URL(request.url)
    const runId = env.SMOKE_RUN_ID ?? ""
    const token = env.SMOKE_OWNERSHIP_TOKEN ?? ""
    const authorization = request.headers.get("authorization") ?? ""
    if (request.method !== "GET" || url.pathname !== "/__ome-smoke-ownership" || url.search || url.hash ||
      !/^[a-f0-9]{32}$/.test(runId) || !token || !(await sameToken(authorization, `Bearer ${token}`))) {
      return new Response(null, { status: 404 })
    }
    return Response.json({ runId }, { headers: { "cache-control": "private, no-store" } })
  }
} satisfies ExportedHandler<OwnershipEnv>
