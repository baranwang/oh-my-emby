import { realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"

import { Effect } from "effect"

import { isDashboardNavigationRequest } from "../../api/application.js"

const plain = (status: number, body: string) => new Response(body, {
  status,
  headers: { "content-type": "text/plain; charset=utf-8" }
})

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR")

const existingRealPath = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`)

const resolveAsset = (request: Request, root: string): string | null => {
  const pathname = new URL(request.url).pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "..") ||
    (decoded !== "/dashboard" && !decoded.startsWith("/dashboard/"))
  ) return null

  const relative = decoded === "/dashboard" ? "index.html" : decoded.slice("/dashboard/".length) || "index.html"
  const path = resolve(root, relative)
  return path === root || path.startsWith(`${root}${sep}`) ? path : null
}

const fileResponse = async (path: string, head: boolean): Promise<Response | null> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  return new Response(head ? null : file, {
    headers: {
      "content-type": file.type || "application/octet-stream",
      "content-length": String(file.size)
    }
  })
}

export const serveDashboardAsset = (
  request: Request,
  assetsRoot: string
): Effect.Effect<Response> => Effect.promise(async () => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method Not Allowed")
  }
  const root = resolve(assetsRoot)
  const path = resolveAsset(request, root)
  if (path === null) return plain(404, "Not Found")

  try {
    const canonicalRoot = await existingRealPath(root)
    if (canonicalRoot === null) return plain(404, "Not Found")

    const canonicalPath = await existingRealPath(path)
    if (canonicalPath !== null) {
      if (!isWithin(canonicalPath, canonicalRoot)) return plain(404, "Not Found")
      return await fileResponse(canonicalPath, request.method === "HEAD") ?? plain(404, "Not Found")
    }
    if (!isDashboardNavigationRequest(request)) return plain(404, "Not Found")

    const fallbackPath = await existingRealPath(resolve(root, "index.html"))
    if (fallbackPath === null || !isWithin(fallbackPath, canonicalRoot)) return plain(404, "Not Found")
    return await fileResponse(fallbackPath, request.method === "HEAD") ?? plain(404, "Not Found")
  } catch {
    return plain(502, "Asset service unavailable")
  }
})
