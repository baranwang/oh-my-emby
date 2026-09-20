import { Effect } from "effect"

import { isDashboardNavigationRequest } from "../../api/application.js"

export interface AssetsBinding {
  readonly fetch: (request: Request) => Promise<Response>
}

const plain = (status: number, body: string) => new Response(body, {
  status,
  headers: { "content-type": "text/plain; charset=utf-8" }
})

const assetPath = (request: Request): string | null => {
  const pathname = new URL(request.url).pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "..") ||
    (decoded !== "/dashboard" && !decoded.startsWith("/dashboard/"))
  ) return null
  return pathname === "/dashboard" ? "/" : pathname.slice("/dashboard".length) || "/"
}

const assetRequest = (request: Request, pathname: string) => {
  const url = new URL(request.url)
  url.pathname = pathname
  return new Request(url, request)
}

export const serveDashboardAsset = (
  request: Request,
  assets: AssetsBinding
): Effect.Effect<Response> => Effect.promise(async () => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method Not Allowed")
  }
  const pathname = assetPath(request)
  if (pathname === null) return plain(404, "Not Found")

  try {
    const exact = await assets.fetch(assetRequest(request, pathname))
    if (exact.status !== 404) return exact
    if (!isDashboardNavigationRequest(request)) return plain(404, "Not Found")
    const fallback = await assets.fetch(assetRequest(request, "/index.html"))
    return fallback.status === 404 ? plain(404, "Not Found") : fallback
  } catch {
    return plain(502, "Asset service unavailable")
  }
})
